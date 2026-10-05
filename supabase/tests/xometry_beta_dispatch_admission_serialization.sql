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
-- A fresh request takes every row it validates or later writes with NOWAIT
-- (the job and its manufacturing_quote/part service request line item FOR NO
-- KEY UPDATE; parts, approved requirements and CAD/drawing files FOR SHARE)
-- and maps SQLSTATE 55P03 to P0001 xometry_beta_job_busy, so it never queues
-- behind a row held by an in-flight edit. An exact replay of a committed
-- dispatch finds its permit first and takes no row lock.
--
-- R1 (edit first): an editor holds an uncommitted edit and the request
--   starts. Expected: the request returns while the editor's transaction is
--   still open, without ever being a Lock waiter, fails with
--   xometry_beta_job_busy and persists nothing; after the editor commits, a
--   fresh request fails with the field's denial.
-- R2 (request first): a driver session holds the organization's founding-beta
--   advisory lock, which the request takes only after its scope row locks.
--   Expected: the editor's UPDATE is a Lock waiter blocked by the request;
--   after release the request is created from the pre-edit scope and the edit
--   commits afterwards.
-- R3: a legacy request, a generic api_request_provider_dispatch on a second
--   job in the same organization, a requirement editor and a client
--   api_reset_client_part_property_overrides on the legacy job all finish,
--   with no 40P01 under statement_timeout = 10s.
-- R4 (worker trusted-hash staging, reversed order): a driver holds the part
--   FOR SHARE, so the worker's api_register_trusted_file_hash parks holding
--   the CAD job_files row (FOR UPDATE) while it waits for the part FOR UPDATE.
--   The request then starts. Expected: the request returns busy without a
--   Lock wait and persists nothing; after the driver commits the worker
--   finishes; neither side sees 40P01.
-- R5 (client reset-overrides, reversed order): as R4, but the parked writer
--   is api_reset_client_part_property_overrides holding the requirement row
--   while it waits for the part. Expected: the request returns busy without a
--   Lock wait; the client's reset then commits; neither side sees 40P01.
-- R6 (client cancel of an older request on the same job, P1): the request
--   holds its scope rows and is parked on the driver's founding-beta lock; the
--   client's api_cancel_quote_request syncs the shared line item and waits on
--   the request. Expected: the request is created, the cancel then commits, and
--   neither side sees 40P01 (with the job row only FOR SHARE the request later
--   waited on the cancel's line item and the cancel was the 40P01 victim).
-- Replay: while another session holds a scope row, an exact replay of a
--   committed dispatch returns the deduplicated result without a Lock wait and
--   never xometry_beta_job_busy; a fresh approval on the same job is busy.
-- Job-row strength: while another session holds the job FOR SHARE (as the
--   generic resolver and preflight do), a fresh request fails busy at once
--   instead of waiting at its final jobs status update.
-- R7 (client project deletion): the first request on a job in a project is
--   parked after its locks; the owner's api_delete_project then waits on the
--   request (its ON DELETE SET NULL needs the job row). Expected: no 40P01 on
--   either side (the request's line-item foreign-key check finds the project
--   row already locked FOR KEY SHARE).
--
-- Recorded red run at 9c18f46 (FOR SHARE without NOWAIT; this suite,
-- 63 assertions): R1 F1-F5 the request was a Lock waiter blocked by the editor
-- and then failed with the field's denial instead of xometry_beta_job_busy.
-- R4 and R5 reproduced the reviews' cycles: 40P01 on one side once the driver
-- committed. The exact excerpts are recorded in PR #580.
--
-- Recorded red run at c5adabe (job row FOR SHARE NOWAIT, no line-item or
-- foreign-key parent locks, helper before the replay lookup; this suite,
-- 76 assertions): Failed 7/76 (tests 7, 61, 63-64, 66-67, 70). R6: the
-- client cancel was the 40P01 victim. Replay: the exact replay of a committed
-- dispatch returned xometry_beta_job_busy. Job row: the request was a Lock
-- waiter at its final status update. R7: the client project delete was the
-- 40P01 victim. With the request body of 20261002182910 (no helper call) R6
-- and R7 showed no wait at all, so both cycles came from this migration's
-- job-row lock.
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
  delete from public.projects where organization_id = v_org;
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
  foreach v_name in array array['ovd598_req', 'ovd598_generic', 'ovd598_editor', 'ovd598_driver', 'ovd598_worker',
    'ovd598_resetter', 'ovd598_canceller', 'ovd598_holder'] loop
    if v_name = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
      perform extensions.dblink_disconnect(v_name);
    end if;
  end loop;
end;
$$;
select public.ovd598_cleanup_admission_fixture();

select plan(76);

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
    when 'ref' then '5000000000' when 'project' then '6000000000' end
    || pg_catalog.lpad(p_k::text, 2, '0'))::uuid
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
-- Job 15: R4 (worker trusted-hash staging). Job 16: R5 (client reset).
-- Job 17: R6 (client cancel of an older request). Job 18: replay while busy.
-- Job 19: job-row strength. Job 20: R7 (client project deletion).
do $$
declare
  v_k integer;
  v_line_item uuid;
  v_request uuid;
begin
  for v_k in 1..11 loop
    perform pg_temp.ovd598_add_job(v_k, 'xometry', true);
  end loop;
  perform pg_temp.ovd598_add_job(12, 'fictiv', false);
  insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
  values (pg_temp.ovd598_id('job', 13), pg_temp.ovd598_org(), pg_temp.ovd598_user(), 'OVD-598 sibling job',
    'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote');
  perform pg_temp.ovd598_add_job(14, 'xometry', true);
  perform pg_temp.ovd598_add_job(15, 'xometry', true);
  perform pg_temp.ovd598_add_job(16, 'xometry', true);
  for v_k in 17..20 loop
    perform pg_temp.ovd598_add_job(v_k, 'xometry', true);
  end loop;
  -- R7: job 20 belongs to a project that its owner deletes during the race.
  insert into public.projects (id, organization_id, owner_user_id, name)
  values (pg_temp.ovd598_id('project', 20), pg_temp.ovd598_org(), pg_temp.ovd598_user(), 'OVD-598 R7 project');
  insert into public.project_memberships (project_id, user_id, role)
  values (pg_temp.ovd598_id('project', 20), pg_temp.ovd598_user(), 'owner');
  update public.jobs set project_id = pg_temp.ovd598_id('project', 20) where id = pg_temp.ovd598_id('job', 20);
  -- R6: an older, still cancelable fictiv request on job 17 that shares the
  -- job's manufacturing_quote/part line item with the Xometry request.
  insert into public.service_request_line_items (organization_id, job_id, service_type, scope, status)
  values (pg_temp.ovd598_org(), pg_temp.ovd598_id('job', 17), 'manufacturing_quote', 'part', 'open')
  returning id into v_line_item;
  insert into public.quote_requests (organization_id, job_id, requested_by, requested_vendors,
    service_request_line_item_id, status)
  values (pg_temp.ovd598_org(), pg_temp.ovd598_id('job', 17), pg_temp.ovd598_user(),
    array['fictiv']::public.vendor_name[], v_line_item, 'queued')
  returning id into v_request;
  insert into public.quote_runs (quote_request_id, job_id, organization_id, initiated_by, status, requested_auto_publish)
  values (v_request, pg_temp.ovd598_id('job', 17), pg_temp.ovd598_org(), pg_temp.ovd598_user(), 'queued', false);
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

-- The worker's real staging call, as service_role.
create or replace function public.ovd598_worker_attempt(p_job_file_id uuid, p_content_sha256 text)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
  perform public.api_register_trusted_file_hash(p_job_file_id, p_content_sha256);
  return pg_catalog.jsonb_build_object('registered', true);
exception when others then
  return pg_catalog.jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
end;
$$;

-- The client's real property-override reset, as the fixture's verified user.
create or replace function public.ovd598_reset_attempt(p_job_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8598-000000000001","role":"authenticated","aal":"aal1"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8598-000000000001', true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  return pg_catalog.jsonb_build_object('jobId',
    public.api_reset_client_part_property_overrides(p_job_id, array['description']));
exception when others then
  return pg_catalog.jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
end;
$$;

-- The client's real cancel of a quote request, as the fixture's verified user.
create or replace function public.ovd598_cancel_attempt(p_request_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8598-000000000001","role":"authenticated","aal":"aal1"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8598-000000000001', true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  return public.api_cancel_quote_request(p_request_id);
exception when others then
  return pg_catalog.jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
end;
$$;

-- The client's real project deletion, as the fixture's verified project owner.
create or replace function public.ovd598_delete_project_attempt(p_project_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8598-000000000001","role":"authenticated","aal":"aal1"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8598-000000000001', true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  return pg_catalog.jsonb_build_object('deleted', public.api_delete_project(p_project_id));
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
revoke all on function public.ovd598_worker_attempt(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.ovd598_reset_attempt(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ovd598_cancel_attempt(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ovd598_delete_project_attempt(uuid) from public, anon, authenticated, service_role;
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
  from pg_catalog.unnest(array[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 18, 19, 20]) k
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
  (select pg_catalog.strpos(p.prosrc, E'  if v_existing.id is null then\n'
       || E'    perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);\n  end if;\n') > 0
     and (length(p.prosrc) - length(replace(p.prosrc, 'lock_xometry_beta_dispatch_scope_rows', '')))
       = length('lock_xometry_beta_dispatch_scope_rows')
     and pg_catalog.strpos(p.prosrc, 'perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);')
       > pg_catalog.strpos(p.prosrc, '''xometry-beta-approval:''')
     and pg_catalog.strpos(p.prosrc, 'perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);')
       > pg_catalog.strpos(p.prosrc, 'select permit.* into v_existing')
     and pg_catalog.strpos(p.prosrc, 'perform private.lock_xometry_beta_dispatch_scope_rows(p_job_id);')
       < pg_catalog.strpos(p.prosrc, 'private.resolve_xometry_beta_dispatch_scope_with_access(')
   from pg_catalog.pg_proc p
   where p.oid = 'public.api_request_xometry_beta_dispatch(uuid,text,text,text,uuid,boolean,boolean,boolean)'::regprocedure),
  'a fresh request locks its scope rows after the approval lock and replay lookup, before the resolver; a replay takes none');

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

-- 'finished' once the async query on p_name has returned, or 'lock_waiter'
-- once p_pid is a heavyweight Lock waiter blocked by one of p_blockers. A
-- fail-fast request returns 'finished' while its blocker is still open.
create function pg_temp.ovd598_finished_or_waiting(p_name text, p_pid integer, p_blockers integer[])
returns text
language plpgsql
set search_path = pg_catalog
as $$
begin
  for attempt in 1..250 loop
    if extensions.dblink_is_busy(p_name) = 0 then
      return 'finished';
    end if;
    perform pg_catalog.pg_stat_clear_snapshot();
    if exists (select 1 from pg_catalog.pg_stat_activity activity
        where activity.pid = p_pid and activity.wait_event_type = 'Lock')
      and pg_catalog.pg_blocking_pids(p_pid) && p_blockers then
      return 'lock_waiter';
    end if;
    perform pg_catalog.pg_sleep(0.02);
  end loop;
  return 'undecided';
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
  edit_result jsonb, request_waited boolean, editor_waited boolean, request_state text,
  rows_while_open boolean, fresh_result jsonb, primary key (race, field));

-- R1: the edit is uncommitted when the request starts. The request must
-- return while the editor's transaction is still open; only then does the
-- editor commit and a fresh request validate the committed edit.
create function pg_temp.ovd598_edit_first(p_field text, p_k integer)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_pid integer := pg_temp.ovd598_open('ovd598_req');
  v_editor_pid integer := pg_temp.ovd598_open('ovd598_editor');
  v_state text;
  v_result jsonb;
  v_rows boolean;
  v_fresh jsonb;
begin
  perform extensions.dblink_exec('ovd598_editor', 'begin');
  perform extensions.dblink_exec('ovd598_editor', pg_temp.ovd598_edit_sql(p_field, p_k));
  perform extensions.dblink_send_query('ovd598_req', pg_temp.ovd598_request_sql(p_k));
  v_state := pg_temp.ovd598_finished_or_waiting('ovd598_req', v_request_pid, array[v_editor_pid]);
  if v_state <> 'finished' then
    -- Old waiting behaviour: release the editor so the request can return.
    perform extensions.dblink_exec('ovd598_editor', 'commit');
  end if;
  select result into v_result from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  v_rows := exists (select 1 from private.xometry_beta_dispatch_permits where job_id = pg_temp.ovd598_id('job', p_k))
    or exists (select 1 from public.quote_requests where job_id = pg_temp.ovd598_id('job', p_k))
    or exists (select 1 from public.work_queue where job_id = pg_temp.ovd598_id('job', p_k));
  if v_state = 'finished' then
    perform extensions.dblink_exec('ovd598_editor', 'commit');
  end if;
  select result into v_fresh
  from extensions.dblink('ovd598_req', pg_temp.ovd598_request_sql(p_k)) as response(result jsonb);
  insert into ovd598_outcomes (race, field, result, request_waited, request_state, rows_while_open, fresh_result)
  values ('R1', p_field, v_result, v_state = 'lock_waiter', v_state, v_rows, v_fresh);
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

select is(o.request_state, 'finished',
  'R1 ' || f.field || ': the request returns while the ' || f.label || ' edit is uncommitted, never a Lock waiter')
from ovd598_fields f left join ovd598_outcomes o on o.race = 'R1' and o.field = f.field order by f.field;

select is((o.result ->> 'sqlstate') || ' ' || (o.result ->> 'error'), 'P0001 xometry_beta_job_busy',
  'R1 ' || f.field || ': the request fails immediately with P0001 xometry_beta_job_busy')
from ovd598_fields f left join ovd598_outcomes o on o.race = 'R1' and o.field = f.field order by f.field;

select ok(
  coalesce(not o.rows_while_open, false)
  and not exists (select 1 from private.xometry_beta_dispatch_permits where job_id = pg_temp.ovd598_id('job', f.r1_k))
  and not exists (select 1 from public.quote_requests where job_id = pg_temp.ovd598_id('job', f.r1_k))
  and not exists (select 1 from public.work_queue where job_id = pg_temp.ovd598_id('job', f.r1_k)),
  'R1 ' || f.field || ': the refused requests leave no permit, quote request or work queue row')
from ovd598_fields f left join ovd598_outcomes o on o.race = 'R1' and o.field = f.field order by f.field;

select is(o.fresh_result ->> 'error', f.denial,
  'R1 ' || f.field || ': after the ' || f.label || ' edit commits a fresh request fails with ' || f.denial)
from ovd598_fields f left join ovd598_outcomes o on o.race = 'R1' and o.field = f.field order by f.field;

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

-- R4 and R5: a writer that takes the scope rows in the reverse order is
-- parked by a driver's part FOR SHARE while it holds a later scope row
-- (R4: the CAD job_files row; R5: the requirement row). With waiting row
-- locks the request queued behind that row while holding the part share, and
-- the writer's part update then closed a cycle (40P01) once the driver
-- committed.
create temporary table ovd598_reversed (race text primary key, writer_parked boolean,
  request_state text, result jsonb, writer jsonb, rows_left boolean);

create function pg_temp.ovd598_reversed_writer_race(p_race text, p_k integer, p_writer text, p_writer_sql text)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_pid integer := pg_temp.ovd598_open('ovd598_req');
  v_writer_pid integer := pg_temp.ovd598_open(p_writer);
  v_driver_pid integer := pg_temp.ovd598_open('ovd598_driver');
  v_parked boolean;
  v_state text;
  v_result jsonb;
  v_writer jsonb;
begin
  perform extensions.dblink_exec('ovd598_driver', 'begin');
  perform * from extensions.dblink('ovd598_driver', pg_catalog.format(
    'select 1 from public.parts where id = %L::uuid for share', pg_temp.ovd598_id('part', p_k))) as remote(one integer);
  perform extensions.dblink_send_query(p_writer, p_writer_sql);
  v_parked := pg_temp.ovd598_blocked_by(v_writer_pid, array[v_driver_pid]);
  perform extensions.dblink_send_query('ovd598_req', pg_temp.ovd598_request_sql(p_k));
  v_state := pg_temp.ovd598_finished_or_waiting('ovd598_req', v_request_pid, array[v_writer_pid]);
  perform extensions.dblink_exec('ovd598_driver', 'commit');
  select result into v_result from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  select result into v_writer from extensions.dblink_get_result(p_writer, false) as response(result jsonb);
  perform * from extensions.dblink_get_result(p_writer, false) as response(result jsonb);
  insert into ovd598_reversed values (p_race, v_parked, v_state, v_result, v_writer,
    exists (select 1 from private.xometry_beta_dispatch_permits where job_id = pg_temp.ovd598_id('job', p_k))
    or exists (select 1 from public.quote_requests where job_id = pg_temp.ovd598_id('job', p_k))
    or exists (select 1 from public.work_queue where job_id = pg_temp.ovd598_id('job', p_k)));
  perform pg_temp.ovd598_close('ovd598_req');
  perform pg_temp.ovd598_close(p_writer);
  perform pg_temp.ovd598_close('ovd598_driver');
end;
$$;

select pg_temp.ovd598_reversed_writer_race('R4', 15, 'ovd598_worker', pg_catalog.format(
  'select public.ovd598_worker_attempt(%L::uuid, %L)', pg_temp.ovd598_id('cad', 15),
  pg_catalog.md5('ovd598-cad-15') || pg_catalog.md5('ovd598-cad-tail-15')));
select pg_temp.ovd598_reversed_writer_race('R5', 16, 'ovd598_resetter', pg_catalog.format(
  'select public.ovd598_reset_attempt(%L::uuid)', pg_temp.ovd598_id('job', 16)));

select diag(race || ': writer_parked=' || coalesce(writer_parked::text, 'null')
  || ' request_state=' || coalesce(request_state, 'null')
  || ' request=' || coalesce(result::text, 'null') || ' writer=' || coalesce(writer::text, 'null'))
from ovd598_reversed order by race;

select ok((select writer_parked from ovd598_reversed where race = 'R4'),
  'R4: the worker''s trusted-hash call holds the CAD job_files row and is a Lock waiter on the driver''s part share');
select is((select request_state || ' ' || (result ->> 'sqlstate') || ' ' || (result ->> 'error')
    from ovd598_reversed where race = 'R4'),
  'finished P0001 xometry_beta_job_busy',
  'R4: the request returns xometry_beta_job_busy without a Lock wait on the worker');
select ok((select result ->> 'sqlstate' is distinct from '40P01' and writer ->> 'sqlstate' is null
      and (writer ->> 'registered')::boolean
    from ovd598_reversed where race = 'R4'),
  'R4: the worker finishes after the driver commits and no side sees 40P01');
select ok((select not rows_left from ovd598_reversed where race = 'R4'),
  'R4: the refused request leaves no permit, quote request or work queue row');

select ok((select writer_parked from ovd598_reversed where race = 'R5'),
  'R5: the client reset holds the requirement row and is a Lock waiter on the driver''s part share');
select is((select request_state || ' ' || (result ->> 'sqlstate') || ' ' || (result ->> 'error')
    from ovd598_reversed where race = 'R5'),
  'finished P0001 xometry_beta_job_busy',
  'R5: the request returns xometry_beta_job_busy without a Lock wait on the client reset');
select ok((select result ->> 'sqlstate' is distinct from '40P01' and writer ->> 'sqlstate' is null
      and writer ->> 'jobId' = pg_temp.ovd598_id('job', 16)::text
    from ovd598_reversed where race = 'R5'),
  'R5: the client reset commits after the driver commits and no side sees 40P01 (the client edit is never the victim)');
select ok((select not rows_left from ovd598_reversed where race = 'R5'),
  'R5: the refused request leaves no permit, quote request or work queue row');

-- R6 (P1): the request holds its scope rows, including the job's line item
-- FOR NO KEY UPDATE, and is parked on the driver's founding-beta lock. The
-- client then cancels the older request on the same job: the quote_requests
-- status sync updates the shared line item and waits on the request. With the
-- job row only FOR SHARE, the cancel instead reached its jobs update and
-- waited on the request, while the request's line-item upsert waited on the
-- cancel: 40P01, and the cancel was the victim.
create temporary table ovd598_r6 (request_parked boolean, cancel_waited boolean, request jsonb, cancel jsonb);

create function pg_temp.ovd598_cancel_race()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_key constant bigint := pg_catalog.hashtextextended('founding-beta:' || pg_temp.ovd598_org()::text, 0);
  v_older uuid := (select request_row.id from public.quote_requests request_row
    where request_row.job_id = pg_temp.ovd598_id('job', 17)
      and request_row.requested_vendors = array['fictiv']::public.vendor_name[]);
  v_request_pid integer := pg_temp.ovd598_open('ovd598_req');
  v_cancel_pid integer := pg_temp.ovd598_open('ovd598_canceller');
  v_driver_pid integer := pg_temp.ovd598_open('ovd598_driver');
  v_parked boolean;
  v_cancel_waited boolean;
  v_result jsonb;
  v_cancel jsonb;
begin
  perform * from extensions.dblink('ovd598_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_lock(%s)::text', v_key)) as remote(locked text);
  perform extensions.dblink_send_query('ovd598_req', pg_temp.ovd598_request_sql(17));
  v_parked := pg_temp.ovd598_blocked_by(v_request_pid, array[v_driver_pid]);
  perform extensions.dblink_send_query('ovd598_canceller', pg_catalog.format(
    'select public.ovd598_cancel_attempt(%L::uuid)', v_older));
  v_cancel_waited := pg_temp.ovd598_blocked_by(v_cancel_pid, array[v_request_pid]);
  perform * from extensions.dblink('ovd598_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_unlock(%s)', v_key)) as remote(unlocked boolean);
  select result into v_result from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  select result into v_cancel from extensions.dblink_get_result('ovd598_canceller', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_canceller', false) as response(result jsonb);
  insert into ovd598_r6 values (v_parked, v_cancel_waited, v_result, v_cancel);
  perform pg_temp.ovd598_close('ovd598_req');
  perform pg_temp.ovd598_close('ovd598_canceller');
  perform pg_temp.ovd598_close('ovd598_driver');
end;
$$;

select pg_temp.ovd598_cancel_race();

select diag('R6: request_parked=' || coalesce(request_parked::text, 'null')
  || ' cancel_waited=' || coalesce(cancel_waited::text, 'null')
  || ' request_error=' || coalesce(request ->> 'sqlstate', 'none') || ' ' || coalesce(request ->> 'error', '')
  || ' created=' || coalesce(request ->> 'created', 'null')
  || ' cancel=' || coalesce(cancel::text, 'null'))
from ovd598_r6;

select ok((select request_parked from ovd598_r6),
  'R6: the request holds its scope rows and is parked on the driver''s founding-beta lock');
select ok((select cancel_waited from ovd598_r6),
  'R6: the client cancel of the older request is a Lock waiter blocked by the request');
select ok(
  coalesce((select request ->> 'sqlstate' is null and (request ->> 'created')::boolean from ovd598_r6), false)
  and exists (select 1 from private.xometry_beta_dispatch_permits where job_id = pg_temp.ovd598_id('job', 17)),
  'R6: the request creates its dispatch and does not see 40P01');
select ok(
  coalesce((select cancel ->> 'sqlstate' is null and (cancel ->> 'canceled')::boolean from ovd598_r6), false)
  and exists (select 1 from public.quote_requests where job_id = pg_temp.ovd598_id('job', 17)
    and requested_vendors = array['fictiv']::public.vendor_name[] and status = 'canceled'),
  'R6: the client cancel then commits and is never the 40P01 victim');

-- Replay while busy: the dispatch on job 18 commits first. The worker's
-- trusted-hash call then holds the CAD job_files row in an open transaction.
-- The exact replay finds its permit before any row lock and returns the
-- deduplicated result; a fresh approval for the same job is busy.
create temporary table ovd598_replay (first jsonb, worker jsonb, replay_state text, replay jsonb,
  fresh_state text, fresh jsonb, after jsonb, permits integer);

create function pg_temp.ovd598_replay_while_busy()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_pid integer := pg_temp.ovd598_open('ovd598_req');
  v_worker_pid integer := pg_temp.ovd598_open('ovd598_worker');
  v_worker_open boolean := true;
  v_first jsonb;
  v_worker jsonb;
  v_replay_state text;
  v_replay jsonb;
  v_fresh_state text;
  v_fresh jsonb;
  v_after jsonb;
begin
  select result into v_first
  from extensions.dblink('ovd598_req', pg_temp.ovd598_request_sql(18)) as response(result jsonb);
  perform extensions.dblink_exec('ovd598_worker', 'begin');
  select result into v_worker from extensions.dblink('ovd598_worker', pg_catalog.format(
    'select public.ovd598_worker_attempt(%L::uuid, %L)', pg_temp.ovd598_id('cad', 18),
    pg_catalog.md5('ovd598-cad-18') || pg_catalog.md5('ovd598-cad-tail-18'))) as response(result jsonb);
  perform extensions.dblink_send_query('ovd598_req', pg_temp.ovd598_request_sql(18));
  v_replay_state := pg_temp.ovd598_finished_or_waiting('ovd598_req', v_request_pid, array[v_worker_pid]);
  if v_replay_state <> 'finished' then
    perform extensions.dblink_exec('ovd598_worker', 'rollback');
    v_worker_open := false;
  end if;
  select result into v_replay from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  perform extensions.dblink_send_query('ovd598_req', pg_catalog.format(
    'select public.ovd598_request_attempt(%L::uuid, %L, %L::uuid)', pg_temp.ovd598_id('job', 18),
    (select scope_fingerprint from ovd598_previews where job_id = pg_temp.ovd598_id('job', 18)),
    pg_temp.ovd598_id('ref', 68)));
  v_fresh_state := pg_temp.ovd598_finished_or_waiting('ovd598_req', v_request_pid, array[v_worker_pid]);
  if v_fresh_state <> 'finished' and v_worker_open then
    perform extensions.dblink_exec('ovd598_worker', 'rollback');
    v_worker_open := false;
  end if;
  select result into v_fresh from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  if v_worker_open then
    perform extensions.dblink_exec('ovd598_worker', 'rollback');
  end if;
  select result into v_after
  from extensions.dblink('ovd598_req', pg_temp.ovd598_request_sql(18)) as response(result jsonb);
  insert into ovd598_replay values (v_first, v_worker, v_replay_state, v_replay, v_fresh_state, v_fresh, v_after,
    (select count(*)::integer from private.xometry_beta_dispatch_permits where job_id = pg_temp.ovd598_id('job', 18)));
  perform pg_temp.ovd598_close('ovd598_req');
  perform pg_temp.ovd598_close('ovd598_worker');
end;
$$;

select pg_temp.ovd598_replay_while_busy();

select diag('Replay: first_created=' || coalesce(first ->> 'created', 'null')
  || ' worker=' || coalesce(worker::text, 'null')
  || ' replay_state=' || coalesce(replay_state, 'null') || ' replay=' || coalesce(replay::text, 'null')
  || ' fresh_state=' || coalesce(fresh_state, 'null') || ' fresh=' || coalesce(fresh::text, 'null')
  || ' permits=' || coalesce(permits::text, 'null'))
from ovd598_replay;

select ok(coalesce((select (first ->> 'created')::boolean and (worker ->> 'registered')::boolean from ovd598_replay), false),
  'Replay: the dispatch commits, then the worker''s trusted-hash call holds the CAD row in an open transaction');
select is((select replay_state || ' ' || coalesce(replay ->> 'deduplicated', 'null') || ' '
    || coalesce(replay ->> 'error', 'none') from ovd598_replay),
  'finished true none',
  'Replay: the exact replay returns the deduplicated result at once, never xometry_beta_job_busy');
select ok(coalesce((select replay ->> 'permitId' = first ->> 'permitId'
    and after ->> 'permitId' = first ->> 'permitId' and (after ->> 'deduplicated')::boolean and permits = 1
  from ovd598_replay), false),
  'Replay: every replay returns the original permit and only one permit exists');
select is((select fresh_state || ' ' || coalesce(fresh ->> 'sqlstate', 'none') || ' ' || coalesce(fresh ->> 'error', 'none')
    from ovd598_replay),
  'finished P0001 xometry_beta_job_busy',
  'Replay: a fresh approval for the same job is busy while the CAD row is held');

-- Job-row strength: a session holds the job FOR SHARE, as the generic
-- resolver and preflight do. A fresh request needs the job FOR NO KEY UPDATE
-- for its final status update, so it fails busy at once instead of waiting.
create temporary table ovd598_job_share (request_state text, result jsonb, rows_left boolean);

create function pg_temp.ovd598_job_share_race()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_pid integer := pg_temp.ovd598_open('ovd598_req');
  v_holder_pid integer := pg_temp.ovd598_open('ovd598_holder');
  v_state text;
  v_result jsonb;
begin
  perform extensions.dblink_exec('ovd598_holder', 'begin');
  perform * from extensions.dblink('ovd598_holder', pg_catalog.format(
    'select 1 from public.jobs where id = %L::uuid for share', pg_temp.ovd598_id('job', 19))) as remote(one integer);
  perform extensions.dblink_send_query('ovd598_req', pg_temp.ovd598_request_sql(19));
  v_state := pg_temp.ovd598_finished_or_waiting('ovd598_req', v_request_pid, array[v_holder_pid]);
  if v_state <> 'finished' then
    perform extensions.dblink_exec('ovd598_holder', 'rollback');
  end if;
  select result into v_result from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  if v_state = 'finished' then
    perform extensions.dblink_exec('ovd598_holder', 'rollback');
  end if;
  insert into ovd598_job_share values (v_state, v_result,
    exists (select 1 from private.xometry_beta_dispatch_permits where job_id = pg_temp.ovd598_id('job', 19))
    or exists (select 1 from public.quote_requests where job_id = pg_temp.ovd598_id('job', 19))
    or exists (select 1 from public.work_queue where job_id = pg_temp.ovd598_id('job', 19)));
  perform pg_temp.ovd598_close('ovd598_req');
  perform pg_temp.ovd598_close('ovd598_holder');
end;
$$;

select pg_temp.ovd598_job_share_race();

select is((select request_state || ' ' || coalesce(result ->> 'sqlstate', 'none') || ' '
    || coalesce(result ->> 'error', 'none') from ovd598_job_share),
  'finished P0001 xometry_beta_job_busy',
  'Job row: a fresh request fails busy at once while another session holds the job FOR SHARE');
select ok((select not rows_left from ovd598_job_share),
  'Job row: the refused request leaves no permit, quote request or work queue row');

-- R7 (client project deletion): job 20 belongs to a project and has no line
-- item yet, so the request's first line-item insert checks the project row.
-- The request is parked after its locks; the project owner then deletes the
-- project, whose ON DELETE SET NULL on jobs.project_id needs the job row.
-- Expected: the delete is a Lock waiter blocked by the request, the request
-- is created, the delete then commits, and neither side sees 40P01. Without
-- the project KEY SHARE lock the delete held the project row while it waited
-- on the request's job lock, the request's foreign-key check then waited on
-- the delete, and the client's delete was the 40P01 victim.
create temporary table ovd598_r7 (request_parked boolean, delete_waited boolean, request jsonb, deleted jsonb);

create function pg_temp.ovd598_project_delete_race()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_key constant bigint := pg_catalog.hashtextextended('founding-beta:' || pg_temp.ovd598_org()::text, 0);
  v_request_pid integer := pg_temp.ovd598_open('ovd598_req');
  v_deleter_pid integer := pg_temp.ovd598_open('ovd598_holder');
  v_driver_pid integer := pg_temp.ovd598_open('ovd598_driver');
  v_parked boolean;
  v_delete_waited boolean;
  v_result jsonb;
  v_deleted jsonb;
begin
  perform * from extensions.dblink('ovd598_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_lock(%s)::text', v_key)) as remote(locked text);
  perform extensions.dblink_send_query('ovd598_req', pg_temp.ovd598_request_sql(20));
  v_parked := pg_temp.ovd598_blocked_by(v_request_pid, array[v_driver_pid]);
  perform extensions.dblink_send_query('ovd598_holder', pg_catalog.format(
    'select public.ovd598_delete_project_attempt(%L::uuid)', pg_temp.ovd598_id('project', 20)));
  v_delete_waited := pg_temp.ovd598_blocked_by(v_deleter_pid, array[v_request_pid]);
  perform * from extensions.dblink('ovd598_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_unlock(%s)', v_key)) as remote(unlocked boolean);
  select result into v_result from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_req', false) as response(result jsonb);
  select result into v_deleted from extensions.dblink_get_result('ovd598_holder', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_holder', false) as response(result jsonb);
  insert into ovd598_r7 values (v_parked, v_delete_waited, v_result, v_deleted);
  perform pg_temp.ovd598_close('ovd598_req');
  perform pg_temp.ovd598_close('ovd598_holder');
  perform pg_temp.ovd598_close('ovd598_driver');
end;
$$;

select pg_temp.ovd598_project_delete_race();

select diag('R7: request_parked=' || coalesce(request_parked::text, 'null')
  || ' delete_waited=' || coalesce(delete_waited::text, 'null')
  || ' request_error=' || coalesce(request ->> 'sqlstate', 'none') || ' ' || coalesce(request ->> 'error', '')
  || ' created=' || coalesce(request ->> 'created', 'null')
  || ' delete=' || coalesce(deleted::text, 'null'))
from ovd598_r7;

select ok((select request_parked and delete_waited from ovd598_r7),
  'R7: the request is parked after its locks and the client project delete is a Lock waiter blocked by it');
select ok(
  coalesce((select request ->> 'sqlstate' is null and (request ->> 'created')::boolean from ovd598_r7), false)
  and exists (select 1 from private.xometry_beta_dispatch_permits where job_id = pg_temp.ovd598_id('job', 20)),
  'R7: the request creates its dispatch and does not see 40P01');
select ok(
  coalesce((select deleted ->> 'sqlstate' is null and deleted ->> 'deleted' = pg_temp.ovd598_id('project', 20)::text
    from ovd598_r7), false)
  and not exists (select 1 from public.projects where id = pg_temp.ovd598_id('project', 20)),
  'R7: the client project delete then commits and is never the 40P01 victim');

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
  editor_waited boolean, timeouts text[], reset jsonb, resetter_waited boolean);

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
  v_resetter_pid integer := pg_temp.ovd598_open('ovd598_resetter');
  v_parked boolean;
  v_editor_waited boolean;
  v_resetter_waited boolean;
  v_legacy jsonb;
  v_generic jsonb;
  v_edit jsonb;
  v_reset jsonb;
  v_timeouts text[];
begin
  select pg_catalog.array_agg(setting order by name) into v_timeouts
  from pg_catalog.unnest(array['ovd598_req', 'ovd598_generic', 'ovd598_editor', 'ovd598_driver',
    'ovd598_resetter']) name
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
  perform extensions.dblink_send_query('ovd598_resetter', pg_catalog.format(
    'select public.ovd598_reset_attempt(%L::uuid)', pg_temp.ovd598_id('job', 11)));
  v_resetter_waited := pg_temp.ovd598_blocked_by(v_resetter_pid,
    array[v_legacy_pid, v_generic_pid, v_editor_pid]);
  perform * from extensions.dblink('ovd598_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_unlock(%s)', v_key)) as remote(unlocked boolean);
  select result into v_legacy from extensions.dblink_get_result('ovd598_req') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_req') as response(result jsonb);
  select result into v_generic from extensions.dblink_get_result('ovd598_generic') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_generic') as response(result jsonb);
  select result into v_edit from extensions.dblink_get_result('ovd598_editor') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_editor') as response(result jsonb);
  select result into v_reset from extensions.dblink_get_result('ovd598_resetter') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd598_resetter') as response(result jsonb);
  insert into ovd598_r3 values (v_legacy, v_generic, v_edit, v_parked, v_editor_waited, v_timeouts,
    v_reset, v_resetter_waited);
  perform pg_temp.ovd598_close('ovd598_req');
  perform pg_temp.ovd598_close('ovd598_generic');
  perform pg_temp.ovd598_close('ovd598_editor');
  perform pg_temp.ovd598_close('ovd598_driver');
  perform pg_temp.ovd598_close('ovd598_resetter');
end;
$$;

select pg_temp.ovd598_mixed_path_race();

select is((select timeouts from ovd598_r3), array['10s', '10s', '10s', '10s', '10s'],
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
select ok(
  (select resetter_waited and reset ->> 'sqlstate' is null
     and reset ->> 'jobId' = pg_temp.ovd598_id('job', 11)::text
   from ovd598_r3),
  'R3: the client property-override reset waits behind the requests and then commits with no 40P01');

begin;
drop function public.ovd598_request_attempt(uuid, text, uuid);
drop function public.ovd598_generic_attempt(uuid, text, uuid);
drop function public.ovd598_edit_attempt(text);
drop function public.ovd598_worker_attempt(uuid, text);
drop function public.ovd598_reset_attempt(uuid);
drop function public.ovd598_cancel_attempt(uuid);
drop function public.ovd598_delete_project_attempt(uuid);
drop function public.ovd598_preview_in_transaction(uuid);
select public.ovd598_cleanup_admission_fixture();
commit;

drop function public.ovd598_cleanup_admission_fixture();

select * from finish();
