-- OVD-628 independent-session races for the generic admission path,
-- public.api_request_provider_dispatch (provider fictiv). Fixtures are
-- committed so real dblink sessions contend on real row and advisory locks.
-- Every fixture row is removed, and the fictiv admission row and the
-- automatic-quote rollout are restored to their seeded default-off state,
-- before the suite finishes. The shape mirrors the legacy-path suite
-- xometry_beta_dispatch_admission_serialization.sql (OVD-598).
--
-- Fields edited concurrently (one fresh job per field and race):
--   F1 approved_part_requirements.requested_by_date
--   F2 approved_part_requirements.applicable_vendors without fictiv
--   F3 jobs.requested_service_kinds
--   F4 the drawing's job_files.file_kind
--   F5 the CAD file's job_files.job_id (moved to a sibling job in the same
--      organization; the resolver rejects it through v_cad.job_id <> v_job.id)
--
-- A fresh request takes every row it validates or later writes with NOWAIT
-- (the job and its manufacturing_quote/part line item FOR NO KEY UPDATE;
-- parts, approved requirements, CAD/drawing files, the provider's admission
-- policy row and its active reviewed envelope FOR SHARE; the job's project
-- FOR KEY SHARE) and maps 55P03 to P0001 provider_dispatch_job_busy, so it
-- never queues behind a row held by an in-flight edit. An exact replay of a
-- committed dispatch finds its permit first and takes no row lock, and the
-- read-only preview takes none either.
--
-- R1 (edit first): an editor holds an uncommitted edit and the request
--   starts. Expected: the request returns while the editor's transaction is
--   still open, without ever being a Lock waiter, fails with
--   provider_dispatch_job_busy and persists nothing; after the editor commits,
--   a fresh request fails with the field's denial.
-- R2 (request first): a driver session holds the organization's founding-beta
--   advisory lock, which the request takes only after its scope row locks.
--   Expected: the editor's UPDATE is a Lock waiter blocked by the request;
--   after release the request is created from the pre-edit scope and the edit
--   commits afterwards.
-- R3 (worker trusted-hash staging, reversed order): a driver holds the part
--   FOR SHARE, so the worker's api_register_trusted_file_hash parks holding
--   the CAD job_files row while it waits for the part FOR UPDATE. The request
--   then starts. Expected: the request returns busy without a Lock wait and
--   persists nothing; after the driver commits the worker finishes; neither
--   side sees 40P01.
-- R4 (client reset-overrides, reversed order): as R3, but the parked writer is
--   api_reset_client_part_property_overrides holding the requirement row while
--   it waits for the part. Expected: busy without a Lock wait; the client's
--   reset then commits; neither side sees 40P01 (the client edit is never the
--   victim).
-- R5 (client api_delete_archived_jobs, both orders, archived jobs 21 and 22):
--   R5a the request is parked after its locks and the delete is a Lock waiter
--   blocked by it; the request is refused (the job is archived) and the delete
--   then commits. R5b the delete holds the job in an open transaction; the
--   request returns busy without a Lock wait; the delete commits. No 40P01 on
--   either side in either order.
-- R6 (client cancel of an older request on the same job): the request holds
--   its scope rows and is parked on the driver's founding-beta lock; the
--   client's api_cancel_quote_request syncs the shared line item and waits on
--   the request. Expected: the request is created, the cancel then commits,
--   and neither side sees 40P01.
-- R7 (client project deletion): the first request on a job in a project is
--   parked after its locks; the owner's api_delete_project then waits on the
--   request (its ON DELETE SET NULL needs the job row). Expected: no 40P01 on
--   either side.
-- Replay: while the worker's trusted-hash call holds the CAD and part rows in
--   an open transaction, an exact replay of a committed dispatch returns the
--   deduplicated result without a Lock wait and never provider_dispatch_job_busy;
--   a fresh approval on the same job is busy.
-- Job-row strength: while another session holds the job FOR SHARE (as the
--   preflight does), a fresh request fails busy at once instead of waiting at
--   its final jobs status update.
-- Line-item strength: while another session holds the job's existing
--   manufacturing_quote/part line item FOR SHARE, a fresh request fails busy
--   at once instead of waiting at its line-item upsert (a FOR SHARE or KEY
--   SHARE line-item lock would let it pass the lock block and then wait).
-- Preview: an open transaction that only previewed the scope blocks no edit.
--
-- Recorded red run against the base definition (claude/server-empty-file-
-- upload-rejection at 72989c8, before migration
-- 20261004130000_ovd628_generic_admission_nowait.sql). The first version of
-- this suite (75 assertions, tests 1-75 below): Failed 30/75 (tests 1-7,
-- 9-18, 49, 51-52, 55-56, 63, 66-67, 69-70, 72, 74-75). This version (77
-- assertions, adding the line-item strength race as tests 76-77): Failed
-- 32/77 (the same 30 plus 76-77). R3 and R4: the request was a Lock waiter
-- and the 40P01 victim. R6 and R7: the client cancel and the client project
-- delete were the 40P01 victims. R1, R5b, job row, line item and replay: the
-- request was a Lock waiter instead of failing fast or deduplicating at once.
-- Preview: the requirement edit hit lock_timeout behind an open preview. The
-- exact excerpts are recorded in the PR body.
--
-- Recorded mutation runs (helper or request replaced on the reset local DB,
-- then the migration re-applied; never committed). With 75 assertions:
-- job_files lock without NOWAIT, Failed 7/75 (12-13, 17-18, 51-52, 75; R3
-- 40P01); requirements lock without NOWAIT, Failed 7/75 (9-10, 14-15, 55-56,
-- 75; R4 40P01); line-item lock removed, Failed 2/75 (63, 75; R6 cancel
-- 40P01); project lock removed, Failed 2/75 (66, 75; R7 delete 40P01); helper
-- call moved before the replay lookup, Failed 3/75 (6, 72-73; replay busy);
-- resolver with its old waiting locks, Failed 4/75 (7, 49, 72, 74; replay
-- Lock waiter, preview blocks). With 77 assertions: line-item lock weakened
-- to FOR SHARE NOWAIT, Failed 2/77 (76-77; the request passes the lock block,
-- then is a Lock waiter at its line-item upsert); weakened to FOR KEY SHARE
-- NOWAIT, Failed 4/77 (63, 75-77; also R6 cancel 40P01).

create extension if not exists dblink with schema extensions;

create or replace function public.ovd628_cleanup_admission_fixture()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_org constant uuid := '00000000-0000-4000-8628-000000000002'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
begin
  alter table private.provider_dispatch_permits disable trigger provider_dispatch_permits_append_only;
  delete from private.provider_dispatch_permits where organization_id = v_org;
  alter table private.provider_dispatch_permits enable trigger provider_dispatch_permits_append_only;
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
  delete from auth.users where id = '00000000-0000-4000-8628-000000000001'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
  update private.commercial_rollout_controls
  set enabled = false, revision = 0,
      change_reason = 'Default-off automatic quote rollout',
      updated_by_user_id = null, updated_by_actor = null
  where capability = 'automatic_quote_collection';
end;
$$;
revoke all on function public.ovd628_cleanup_admission_fixture() from public, anon, authenticated, service_role;

-- Self-heal committed rows and connections left by an interrupted run.
do $$
declare
  v_name text;
begin
  foreach v_name in array array['ovd628_req', 'ovd628_editor', 'ovd628_driver', 'ovd628_worker',
    'ovd628_resetter', 'ovd628_canceller', 'ovd628_holder'] loop
    if v_name = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
      perform extensions.dblink_disconnect(v_name);
    end if;
  end loop;
end;
$$;
select public.ovd628_cleanup_admission_fixture();

select plan(77);

create function pg_temp.ovd628_org() returns uuid language sql immutable
as $$ select '00000000-0000-4000-8628-000000000002'::uuid $$;
create function pg_temp.ovd628_user() returns uuid language sql immutable
as $$ select '00000000-0000-4000-8628-000000000001'::uuid $$;
-- One deterministic identifier per fixture kind and job index.
create function pg_temp.ovd628_id(p_kind text, p_k integer) returns uuid language sql immutable
as $$
  select ('00000000-0000-4000-8628-' || case p_kind
    when 'job' then '1000000000' when 'cad_blob' then '2000000000'
    when 'drawing_blob' then '2100000000' when 'cad' then '3000000000'
    when 'drawing' then '3100000000' when 'part' then '4000000000'
    when 'ref' then '5000000000' when 'project' then '6000000000' end
    || pg_catalog.lpad(p_k::text, 2, '0'))::uuid
$$;

begin;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values (pg_temp.ovd628_user(), 'authenticated', 'authenticated',
  'ovd628-admission@example.test', timezone('utc', now()));
insert into public.organizations (id, name, slug)
values (pg_temp.ovd628_org(), 'OVD 628 Admission', 'ovd-628-admission');
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
  now() + interval '30 days', 'OVD-628 admission fixture', pg_temp.ovd628_user());
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
) values (pg_temp.ovd628_org(), pg_temp.ovd628_user(), 'grant', 'OVD-628 admission fixture',
  'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy', 'ovd628-admission-grant');
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
values (pg_temp.ovd628_org(), pg_temp.ovd628_user(), 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy');
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
values (pg_temp.ovd628_org(), 'fictiv', true);
-- Many requests are created by one user; lift only this fixture's rate and
-- pending-cost ceilings so the default guardrails do not mask the races.
insert into public.quote_request_guardrails (organization_id, user_max_requests_per_window, org_pending_cost_ceiling_usd)
values (pg_temp.ovd628_org(), 1000, 1000000);
update private.commercial_rollout_controls
set enabled = true, revision = revision + 1, change_reason = 'OVD-628 admission fixture'
where capability = 'automatic_quote_collection';
-- Enable the generic fictiv route (STEP CAD plus PDF drawing).
update private.quote_provider_admission_policies
set admission_state = 'approved', generic_dispatch_enabled = true,
  policy_revision = 'fictiv-ovd628-race.v1', evidence_reference = 'OVD-628',
  permission_basis = 'written_provider_authorization',
  supported_processes = array['cnc_milling']::public.process_types[],
  accepted_file_extensions = array['step', 'stp', 'pdf'], session_owner = 'overdrafter_managed',
  reviewed_by = pg_temp.ovd628_user(), reviewed_at = now() - interval '1 day',
  expires_at = null, change_reason = 'approval_recorded'
where provider = 'fictiv';
insert into private.provider_dispatch_envelope_reviews (provider, envelope_id, envelope_version, evidence_reference, permit_ttl_seconds)
values ('fictiv', 'fictiv-ovd628-race-envelope', 1, 'OVD-628', 900);

create function pg_temp.ovd628_add_job(p_k integer)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_org constant uuid := pg_temp.ovd628_org();
  v_user constant uuid := pg_temp.ovd628_user();
  v_job constant uuid := pg_temp.ovd628_id('job', p_k);
  v_cad_hash constant text := pg_catalog.md5('ovd628-cad-' || p_k) || pg_catalog.md5('ovd628-cad-tail-' || p_k);
  v_drawing_hash constant text := pg_catalog.md5('ovd628-drawing-' || p_k) || pg_catalog.md5('ovd628-drawing-tail-' || p_k);
begin
  insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
  values (v_job, v_org, v_user, 'OVD-628 admission part ' || p_k, 'ready_to_quote',
    array['manufacturing_quote'], 'manufacturing_quote');
  insert into public.organization_file_blobs (
    id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
  ) values (pg_temp.ovd628_id('cad_blob', p_k), v_org, v_cad_hash, v_cad_hash, 'job-files',
    'ovd628-admission/' || p_k || '/part.step', 100, 'application/step');
  insert into public.job_files (
    id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
  ) values (pg_temp.ovd628_id('cad', p_k), v_job, v_org, v_user, pg_temp.ovd628_id('cad_blob', p_k),
    v_cad_hash, v_cad_hash, 'job-files', 'ovd628-admission/' || p_k || '/part.step',
    'part-' || p_k || '.step', 'part-' || p_k, 'cad', 'application/step', 100);
  insert into public.organization_file_blobs (
    id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
  ) values (pg_temp.ovd628_id('drawing_blob', p_k), v_org, v_drawing_hash, v_drawing_hash, 'job-files',
    'ovd628-admission/' || p_k || '/drawing.pdf', 100, 'application/pdf');
  insert into public.job_files (
    id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
  ) values (pg_temp.ovd628_id('drawing', p_k), v_job, v_org, v_user, pg_temp.ovd628_id('drawing_blob', p_k),
    v_drawing_hash, v_drawing_hash, 'job-files', 'ovd628-admission/' || p_k || '/drawing.pdf',
    'drawing-' || p_k || '.pdf', 'drawing-' || p_k, 'drawing', 'application/pdf', 100);
  insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, drawing_file_id, quantity)
  values (pg_temp.ovd628_id('part', p_k), v_job, v_org, 'Part ' || p_k, 'part-' || p_k,
    pg_temp.ovd628_id('cad', p_k), pg_temp.ovd628_id('drawing', p_k), 1);
  insert into public.approved_part_requirements (
    part_id, organization_id, approved_by, material, finish, tightest_tolerance_inch, quantity,
    quote_quantities, applicable_vendors, spec_snapshot
  ) values (pg_temp.ovd628_id('part', p_k), v_org, v_user, '6061-T6 Aluminum', 'As machined', 0.005, 1,
    array[1], array['fictiv']::public.vendor_name[], '{"process":"CNC milling"}'::jsonb);
end;
$$;

-- Jobs 1-5: R1 F1-F5. Jobs 6-10: R2 F1-F5. Job 13: an empty sibling job that
-- F5 moves the CAD file into. Job 14: the preview probe. Job 15: R3 (worker
-- trusted-hash staging). Job 16: R4 (client reset). Job 17: R6 (client cancel
-- of an older request). Job 18: replay while busy. Job 19: job-row strength.
-- Job 20: R7 (client project deletion). Jobs 21 and 22: R5a and R5b (client
-- deletion of an archived job; archived after the previews are taken).
-- Job 23: line-item strength (an existing open line item, no quote request).
do $$
declare
  v_k integer;
  v_line_item uuid;
  v_request uuid;
begin
  for v_k in 1..10 loop
    perform pg_temp.ovd628_add_job(v_k);
  end loop;
  insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
  values (pg_temp.ovd628_id('job', 13), pg_temp.ovd628_org(), pg_temp.ovd628_user(), 'OVD-628 sibling job',
    'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote');
  for v_k in 14..23 loop
    perform pg_temp.ovd628_add_job(v_k);
  end loop;
  -- R5: the sibling job keeps a reference to the archived jobs' blobs, so the
  -- delete does not try to drop blobs that their canonical part versions
  -- still reference (a separate, pre-existing delete limitation).
  insert into public.job_files (
    job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
    storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
  )
  select pg_temp.ovd628_id('job', 13), pg_temp.ovd628_org(), pg_temp.ovd628_user(), source.blob_id,
    source.content_sha256, source.trusted_content_sha256, source.storage_bucket, source.storage_path,
    'sibling-' || source.original_name, 'sibling-' || source.normalized_name, source.file_kind,
    source.mime_type, source.size_bytes
  from public.job_files source
  where source.job_id in (pg_temp.ovd628_id('job', 21), pg_temp.ovd628_id('job', 22));
  -- R7: job 20 belongs to a project that its owner deletes during the race.
  insert into public.projects (id, organization_id, owner_user_id, name)
  values (pg_temp.ovd628_id('project', 20), pg_temp.ovd628_org(), pg_temp.ovd628_user(), 'OVD-628 R7 project');
  insert into public.project_memberships (project_id, user_id, role)
  values (pg_temp.ovd628_id('project', 20), pg_temp.ovd628_user(), 'owner');
  update public.jobs set project_id = pg_temp.ovd628_id('project', 20) where id = pg_temp.ovd628_id('job', 20);
  -- R6: an older, still cancelable xometry request on job 17 that shares the
  -- job's manufacturing_quote/part line item with the generic request.
  insert into public.service_request_line_items (organization_id, job_id, service_type, scope, status)
  values (pg_temp.ovd628_org(), pg_temp.ovd628_id('job', 17), 'manufacturing_quote', 'part', 'open')
  returning id into v_line_item;
  insert into public.quote_requests (organization_id, job_id, requested_by, requested_vendors,
    service_request_line_item_id, status)
  values (pg_temp.ovd628_org(), pg_temp.ovd628_id('job', 17), pg_temp.ovd628_user(),
    array['xometry']::public.vendor_name[], v_line_item, 'queued')
  returning id into v_request;
  insert into public.quote_runs (quote_request_id, job_id, organization_id, initiated_by, status, requested_auto_publish)
  values (v_request, pg_temp.ovd628_id('job', 17), pg_temp.ovd628_org(), pg_temp.ovd628_user(), 'queued', false);
  -- Line-item strength: job 23 already has its open manufacturing_quote/part
  -- line item, which the request's upsert will update.
  insert into public.service_request_line_items (organization_id, job_id, service_type, scope, status)
  values (pg_temp.ovd628_org(), pg_temp.ovd628_id('job', 23), 'manufacturing_quote', 'part', 'open');
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
    return public.api_request_provider_dispatch(
      p_job_id, 'fictiv', 'inch', p_scope_fingerprint, 'founding-beta-2026-08-15',
      'fictiv-ovd628-race-envelope.v1', p_approval_reference, true, true, true
    );
  exception when others then
    return pg_catalog.jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
  end;
end;
$$;

create or replace function public.ovd628_edit_attempt(p_sql text)
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
create or replace function public.ovd628_worker_attempt(p_job_file_id uuid, p_content_sha256 text)
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

-- The client's real RPCs, as the fixture's verified user.
create or replace function public.ovd628_client_attempt(p_kind text, p_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8628-000000000001","role":"authenticated","aal":"aal1"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8628-000000000001', true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  return case p_kind
    when 'reset' then pg_catalog.jsonb_build_object('jobId',
      public.api_reset_client_part_property_overrides(p_id, array['description']))
    when 'cancel' then public.api_cancel_quote_request(p_id)
    when 'delete_project' then pg_catalog.jsonb_build_object('deleted', public.api_delete_project(p_id))
    when 'delete_archived' then public.api_delete_archived_jobs(array[p_id])
    when 'preview' then public.api_get_provider_dispatch_scope(p_id, 'fictiv', 'inch')
  end;
exception when others then
  return pg_catalog.jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
end;
$$;

revoke all on function public.ovd628_request_attempt(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.ovd628_edit_attempt(text) from public, anon, authenticated, service_role;
revoke all on function public.ovd628_worker_attempt(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.ovd628_client_attempt(text, uuid) from public, anon, authenticated, service_role;

commit;

select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8628-000000000001","role":"authenticated","aal":"aal1"}', false);
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8628-000000000001', false);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);

-- Pre-edit previews: the exact scope each request is expected to bind.
create temporary table ovd628_previews (job_id uuid primary key, scope_fingerprint text not null, scope jsonb not null);
insert into ovd628_previews
select job_id, preview ->> 'scopeFingerprint', preview -> 'scope'
from (
  select pg_temp.ovd628_id('job', k) as job_id,
    public.api_get_provider_dispatch_scope(pg_temp.ovd628_id('job', k), 'fictiv', 'inch') as preview
  from pg_catalog.unnest(array[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 18, 19, 20, 21, 22, 23]) k
) previews;

-- R5: jobs 21 and 22 are archived only after their previews are taken.
begin;
update public.jobs set archived_at = timezone('utc', now())
where id in (pg_temp.ovd628_id('job', 21), pg_temp.ovd628_id('job', 22));
commit;

-- Helper and RPC privileges, placement and the lock-free resolver.
select ok(
  coalesce(not pg_catalog.has_function_privilege(grantee, helper.oid, 'EXECUTE'), false),
  'the generic scope row-lock helper is not executable by ' || grantee
)
from (select pg_catalog.to_regprocedure('private.lock_provider_dispatch_scope_rows(uuid,public.vendor_name)') as oid) helper
cross join pg_catalog.unnest(array['public', 'anon', 'authenticated', 'service_role']) grantee;

select ok(
  coalesce((select p.prosecdef and p.proconfig = array['search_path=pg_catalog']
    from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('private.lock_provider_dispatch_scope_rows(uuid,public.vendor_name)')), false),
  'the helper is a security definer pinned to search_path=pg_catalog');

select ok(
  coalesce((select pg_catalog.strpos(p.prosrc, E'\n  perform private.lock_provider_dispatch_scope_rows(p_job_id, p_provider);\n') > 0
     and (length(p.prosrc) - length(replace(p.prosrc, 'lock_provider_dispatch_scope_rows', '')))
       = length('lock_provider_dispatch_scope_rows')
     and pg_catalog.strpos(p.prosrc, 'lock_provider_dispatch_scope_rows')
       > pg_catalog.strpos(p.prosrc, 'select permit.* into v_existing')
     and pg_catalog.strpos(p.prosrc, 'lock_provider_dispatch_scope_rows')
       > pg_catalog.strpos(p.prosrc, '''status'', ''queued''')
     and pg_catalog.strpos(p.prosrc, 'lock_provider_dispatch_scope_rows')
       < pg_catalog.strpos(p.prosrc, E'  v_scope := private.resolve_provider_dispatch_scope(p_job_id, p_provider, p_declared_model_units);\n  if p_expected_scope_fingerprint is null')
   from pg_catalog.pg_proc p
   where p.oid = pg_catalog.to_regprocedure('public.api_request_provider_dispatch(uuid,public.vendor_name,text,text,text,text,uuid,boolean,boolean,boolean)')), false),
  'a fresh generic request locks its scope rows after the approval lock and replay block, before the resolver; a replay takes none');

select ok(
  coalesce((select p.prosecdef and pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig = array['search_path=pg_catalog']
     and p.prosrc !~* '\mfor\s+(share|update|no\s+key\s+update|key\s+share)\M'
   from pg_catalog.pg_proc p
   where p.oid = pg_catalog.to_regprocedure('private.resolve_provider_dispatch_scope(uuid,public.vendor_name,text)')), false),
  'the generic resolver keeps its definer and search_path and takes no row lock');

select ok(
  pg_catalog.has_function_privilege('authenticated',
    'public.api_request_provider_dispatch(uuid,public.vendor_name,text,text,text,text,uuid,boolean,boolean,boolean)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('anon',
    'public.api_request_provider_dispatch(uuid,public.vendor_name,text,text,text,text,uuid,boolean,boolean,boolean)', 'EXECUTE')
  and not pg_catalog.has_function_privilege('service_role',
    'public.api_request_provider_dispatch(uuid,public.vendor_name,text,text,text,text,uuid,boolean,boolean,boolean)', 'EXECUTE'),
  'the generic request keeps its authenticated-only execute grant');

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

-- 'finished' once the async query on p_name has returned, or 'lock_waiter'
-- once p_pid is a heavyweight Lock waiter blocked by one of p_blockers. A
-- fail-fast request returns 'finished' while its blocker is still open.
create function pg_temp.ovd628_finished_or_waiting(p_name text, p_pid integer, p_blockers integer[])
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

create function pg_temp.ovd628_request_sql(p_k integer, p_ref integer default null)
returns text
language sql
set search_path = pg_catalog
as $$
  select pg_catalog.format('select public.ovd628_request_attempt(%L::uuid, %L, %L::uuid)',
    pg_temp.ovd628_id('job', p_k),
    (select scope_fingerprint from ovd628_previews where job_id = pg_temp.ovd628_id('job', p_k)),
    pg_temp.ovd628_id('ref', coalesce(p_ref, p_k)))
$$;

create function pg_temp.ovd628_client_sql(p_kind text, p_id uuid)
returns text
language sql
set search_path = pg_catalog
as $$
  select pg_catalog.format('select public.ovd628_client_attempt(%L, %L::uuid)', p_kind, p_id)
$$;

-- True when the job has no generic permit, quote request or work queue row.
create function pg_temp.ovd628_no_rows(p_k integer)
returns boolean
language sql
set search_path = pg_catalog
as $$
  select not exists (select 1 from private.provider_dispatch_permits where job_id = pg_temp.ovd628_id('job', p_k))
    and not exists (select 1 from public.quote_requests where job_id = pg_temp.ovd628_id('job', p_k)
      and requested_vendors = array['fictiv']::public.vendor_name[])
    and not exists (select 1 from public.work_queue where job_id = pg_temp.ovd628_id('job', p_k))
$$;

create function pg_temp.ovd628_edit_sql(p_field text, p_k integer)
returns text
language sql
set search_path = pg_catalog
as $$
  select case p_field
    when 'F1' then pg_catalog.format(
      'update public.approved_part_requirements set requested_by_date = date %L where part_id = %L::uuid',
      '2027-01-15', pg_temp.ovd628_id('part', p_k))
    when 'F2' then pg_catalog.format(
      'update public.approved_part_requirements set applicable_vendors = array[%L]::public.vendor_name[] where part_id = %L::uuid',
      'xometry', pg_temp.ovd628_id('part', p_k))
    when 'F3' then pg_catalog.format(
      'update public.jobs set requested_service_kinds = array[%L, %L] where id = %L::uuid',
      'manufacturing_quote', 'dfm_review', pg_temp.ovd628_id('job', p_k))
    when 'F4' then pg_catalog.format(
      'update public.job_files set file_kind = %L where id = %L::uuid',
      'other', pg_temp.ovd628_id('drawing', p_k))
    when 'F5' then pg_catalog.format(
      'update public.job_files set job_id = %L::uuid where id = %L::uuid',
      pg_temp.ovd628_id('job', 13), pg_temp.ovd628_id('cad', p_k))
  end
$$;

create function pg_temp.ovd628_edit_applied(p_field text, p_k integer)
returns boolean
language sql
set search_path = pg_catalog
as $$
  select case p_field
    when 'F1' then exists (select 1 from public.approved_part_requirements
      where part_id = pg_temp.ovd628_id('part', p_k) and requested_by_date = date '2027-01-15')
    when 'F2' then exists (select 1 from public.approved_part_requirements
      where part_id = pg_temp.ovd628_id('part', p_k) and applicable_vendors = array['xometry']::public.vendor_name[])
    when 'F3' then exists (select 1 from public.jobs
      where id = pg_temp.ovd628_id('job', p_k) and requested_service_kinds = array['manufacturing_quote', 'dfm_review'])
    when 'F4' then exists (select 1 from public.job_files
      where id = pg_temp.ovd628_id('drawing', p_k) and file_kind = 'other')
    when 'F5' then exists (select 1 from public.job_files
      where id = pg_temp.ovd628_id('cad', p_k) and job_id = pg_temp.ovd628_id('job', 13))
  end
$$;

create temporary table ovd628_fields (field text primary key, r1_k integer not null, r2_k integer not null,
  label text not null, denial text not null);
insert into ovd628_fields values
  ('F1', 1, 6, 'requested_by_date', 'provider_dispatch_special_requirements_not_supported'),
  ('F2', 2, 7, 'applicable_vendors without fictiv', 'provider_dispatch_provider_applicability_required'),
  ('F3', 3, 8, 'requested_service_kinds', 'provider_dispatch_manufacturing_quote_only'),
  ('F4', 4, 9, 'drawing file_kind', 'provider_dispatch_drawing_not_admitted'),
  ('F5', 5, 10, 'CAD file job ownership', 'provider_dispatch_trusted_cad_required');

create temporary table ovd628_outcomes (race text not null, field text not null, result jsonb,
  edit_result jsonb, request_waited boolean, editor_waited boolean, request_state text,
  rows_while_open boolean, fresh_result jsonb, primary key (race, field));

-- R1: the edit is uncommitted when the request starts. The request must
-- return while the editor's transaction is still open; only then does the
-- editor commit and a fresh request validate the committed edit.
create function pg_temp.ovd628_edit_first(p_field text, p_k integer)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_pid integer := pg_temp.ovd628_open('ovd628_req');
  v_editor_pid integer := pg_temp.ovd628_open('ovd628_editor');
  v_state text;
  v_result jsonb;
  v_rows boolean;
  v_fresh jsonb;
begin
  perform extensions.dblink_exec('ovd628_editor', 'begin');
  perform extensions.dblink_exec('ovd628_editor', pg_temp.ovd628_edit_sql(p_field, p_k));
  perform extensions.dblink_send_query('ovd628_req', pg_temp.ovd628_request_sql(p_k));
  v_state := pg_temp.ovd628_finished_or_waiting('ovd628_req', v_request_pid, array[v_editor_pid]);
  if v_state <> 'finished' then
    -- Old waiting behaviour: release the editor so the request can return.
    perform extensions.dblink_exec('ovd628_editor', 'commit');
  end if;
  select result into v_result from extensions.dblink_get_result('ovd628_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_req', false) as response(result jsonb);
  v_rows := not pg_temp.ovd628_no_rows(p_k);
  if v_state = 'finished' then
    perform extensions.dblink_exec('ovd628_editor', 'commit');
  end if;
  select result into v_fresh
  from extensions.dblink('ovd628_req', pg_temp.ovd628_request_sql(p_k)) as response(result jsonb);
  insert into ovd628_outcomes (race, field, result, request_waited, request_state, rows_while_open, fresh_result)
  values ('R1', p_field, v_result, v_state = 'lock_waiter', v_state, v_rows, v_fresh);
  perform pg_temp.ovd628_close('ovd628_req');
  perform pg_temp.ovd628_close('ovd628_editor');
end;
$$;

-- R2: the request holds its scope rows and is parked on the founding-beta
-- advisory lock held by the driver when the edit starts.
create function pg_temp.ovd628_request_first(p_field text, p_k integer)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_key constant bigint := pg_catalog.hashtextextended('founding-beta:' || pg_temp.ovd628_org()::text, 0);
  v_request_pid integer := pg_temp.ovd628_open('ovd628_req');
  v_editor_pid integer := pg_temp.ovd628_open('ovd628_editor');
  v_driver_pid integer := pg_temp.ovd628_open('ovd628_driver');
  v_parked boolean;
  v_editor_waited boolean;
  v_result jsonb;
  v_edit jsonb;
begin
  perform * from extensions.dblink('ovd628_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_lock(%s)::text', v_key)) as remote(locked text);
  perform extensions.dblink_send_query('ovd628_req', pg_temp.ovd628_request_sql(p_k));
  v_parked := pg_temp.ovd628_blocked_by(v_request_pid, array[v_driver_pid]);
  perform extensions.dblink_send_query('ovd628_editor', pg_catalog.format(
    'select public.ovd628_edit_attempt(%L)', pg_temp.ovd628_edit_sql(p_field, p_k)));
  v_editor_waited := pg_temp.ovd628_blocked_by(v_editor_pid, array[v_request_pid]);
  perform * from extensions.dblink('ovd628_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_unlock(%s)', v_key)) as remote(unlocked boolean);
  select result into v_result from extensions.dblink_get_result('ovd628_req') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_req') as response(result jsonb);
  select result into v_edit from extensions.dblink_get_result('ovd628_editor') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_editor') as response(result jsonb);
  insert into ovd628_outcomes (race, field, result, edit_result, request_waited, editor_waited)
  values ('R2', p_field, v_result, v_edit, v_parked, v_editor_waited);
  perform pg_temp.ovd628_close('ovd628_req');
  perform pg_temp.ovd628_close('ovd628_editor');
  perform pg_temp.ovd628_close('ovd628_driver');
end;
$$;

select pg_temp.ovd628_edit_first(field, r1_k) from ovd628_fields order by field;

select diag(o.race || ' ' || o.field || ': request_state=' || coalesce(o.request_state, 'null')
  || ' request=' || coalesce(o.result::text, 'null')
  || ' fresh=' || coalesce(o.fresh_result::text, 'null'))
from ovd628_outcomes o where o.race = 'R1' order by o.field;

select is(o.request_state, 'finished',
  'R1 ' || f.field || ': the request returns while the ' || f.label || ' edit is uncommitted, never a Lock waiter')
from ovd628_fields f left join ovd628_outcomes o on o.race = 'R1' and o.field = f.field order by f.field;

select is((o.result ->> 'sqlstate') || ' ' || (o.result ->> 'error'), 'P0001 provider_dispatch_job_busy',
  'R1 ' || f.field || ': the request fails immediately with P0001 provider_dispatch_job_busy')
from ovd628_fields f left join ovd628_outcomes o on o.race = 'R1' and o.field = f.field order by f.field;

select ok(coalesce(not o.rows_while_open, false) and pg_temp.ovd628_no_rows(f.r1_k),
  'R1 ' || f.field || ': the refused requests leave no permit, quote request or work queue row')
from ovd628_fields f left join ovd628_outcomes o on o.race = 'R1' and o.field = f.field order by f.field;

select is(o.fresh_result ->> 'error', f.denial,
  'R1 ' || f.field || ': after the ' || f.label || ' edit commits a fresh request fails with ' || f.denial)
from ovd628_fields f left join ovd628_outcomes o on o.race = 'R1' and o.field = f.field order by f.field;

select pg_temp.ovd628_request_first(field, r2_k) from ovd628_fields order by field;

select diag(o.race || ' ' || o.field || ': request_waited=' || coalesce(o.request_waited::text, 'null')
  || ' editor_waited=' || coalesce(o.editor_waited::text, 'null')
  || ' created=' || coalesce(o.result ->> 'created', 'null')
  || ' error=' || coalesce(o.result ->> 'error', 'none')
  || ' edit=' || coalesce(o.edit_result::text, 'none'))
from ovd628_outcomes o where o.race = 'R2' order by o.field;

select ok(coalesce(o.request_waited, false),
  'R2 ' || f.field || ': the request is parked on the driver''s founding-beta lock')
from ovd628_fields f left join ovd628_outcomes o on o.race = 'R2' and o.field = f.field order by f.field;

select ok(coalesce(o.editor_waited, false),
  'R2 ' || f.field || ': the ' || f.label || ' UPDATE is a Lock waiter blocked by the request''s pid')
from ovd628_fields f left join ovd628_outcomes o on o.race = 'R2' and o.field = f.field order by f.field;

select ok(
  coalesce((o.result ->> 'accepted')::boolean and (o.result ->> 'created')::boolean, false),
  'R2 ' || f.field || ': the request is accepted and creates its dispatch')
from ovd628_fields f left join ovd628_outcomes o on o.race = 'R2' and o.field = f.field order by f.field;

select ok(
  coalesce((
    select lane.scope_snapshot = preview.scope
      and permit.scope_fingerprint = preview.scope_fingerprint
      and lane.scope_fingerprint = preview.scope_fingerprint
    from private.provider_dispatch_permits permit
    join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
    join ovd628_previews preview on preview.job_id = permit.job_id
    where permit.job_id = pg_temp.ovd628_id('job', f.r2_k)
  ), false)
  and o.edit_result ->> 'rows' = '1'
  and pg_temp.ovd628_edit_applied(f.field, f.r2_k),
  'R2 ' || f.field || ': the lane and permit bind the pre-edit scope and the ' || f.label || ' edit commits afterwards')
from ovd628_fields f left join ovd628_outcomes o on o.race = 'R2' and o.field = f.field order by f.field;

-- A read-only preview takes no row locks: an editor never waits on an open
-- transaction that only previewed the scope.
create function pg_temp.ovd628_preview_takes_no_row_locks()
returns text
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_preview jsonb;
  v_edit jsonb;
begin
  perform pg_temp.ovd628_open('ovd628_req');
  perform pg_temp.ovd628_open('ovd628_editor');
  perform extensions.dblink_exec('ovd628_req', 'begin');
  select preview into v_preview from extensions.dblink('ovd628_req',
    pg_temp.ovd628_client_sql('preview', pg_temp.ovd628_id('job', 14))) as remote(preview jsonb);
  perform extensions.dblink_exec('ovd628_editor', 'set lock_timeout = ''2s''');
  select edit into v_edit from extensions.dblink('ovd628_editor', pg_catalog.format(
    'select public.ovd628_edit_attempt(%L)', pg_catalog.format(
      'update public.approved_part_requirements set description = %L where part_id = %L::uuid',
      'OVD-628 preview probe', pg_temp.ovd628_id('part', 14)))) as remote(edit jsonb);
  perform extensions.dblink_exec('ovd628_req', 'rollback');
  perform pg_temp.ovd628_close('ovd628_req');
  perform pg_temp.ovd628_close('ovd628_editor');
  return coalesce(v_preview ->> 'scopeFingerprint', 'none') || ' ' || coalesce(v_edit::text, 'none');
end;
$$;

create temporary table ovd628_preview (outcome text);
insert into ovd628_preview select pg_temp.ovd628_preview_takes_no_row_locks();
select diag('Preview: ' || outcome) from ovd628_preview;
select ok((select outcome ~ '^[a-f0-9]{64} \{"rows": 1\}$' from ovd628_preview),
  'Preview: an open transaction that only previewed the generic scope does not block a requirement edit');

-- R3 and R4: a writer that takes the scope rows in the reverse order is
-- parked by a driver's part FOR SHARE while it holds a later scope row
-- (R3: the CAD job_files row; R4: the requirement row). With waiting row
-- locks the request queued behind that row while holding the part share, and
-- the writer's part update then closed a cycle (40P01) once the driver
-- committed.
create temporary table ovd628_reversed (race text primary key, writer_parked boolean,
  request_state text, result jsonb, writer jsonb, rows_left boolean);

create function pg_temp.ovd628_reversed_writer_race(p_race text, p_k integer, p_writer text, p_writer_sql text)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_pid integer := pg_temp.ovd628_open('ovd628_req');
  v_writer_pid integer := pg_temp.ovd628_open(p_writer);
  v_driver_pid integer := pg_temp.ovd628_open('ovd628_driver');
  v_parked boolean;
  v_state text;
  v_result jsonb;
  v_writer jsonb;
begin
  perform extensions.dblink_exec('ovd628_driver', 'begin');
  perform * from extensions.dblink('ovd628_driver', pg_catalog.format(
    'select 1 from public.parts where id = %L::uuid for share', pg_temp.ovd628_id('part', p_k))) as remote(one integer);
  perform extensions.dblink_send_query(p_writer, p_writer_sql);
  v_parked := pg_temp.ovd628_blocked_by(v_writer_pid, array[v_driver_pid]);
  perform extensions.dblink_send_query('ovd628_req', pg_temp.ovd628_request_sql(p_k));
  v_state := pg_temp.ovd628_finished_or_waiting('ovd628_req', v_request_pid, array[v_writer_pid]);
  perform extensions.dblink_exec('ovd628_driver', 'commit');
  select result into v_result from extensions.dblink_get_result('ovd628_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_req', false) as response(result jsonb);
  select result into v_writer from extensions.dblink_get_result(p_writer, false) as response(result jsonb);
  perform * from extensions.dblink_get_result(p_writer, false) as response(result jsonb);
  insert into ovd628_reversed values (p_race, v_parked, v_state, v_result, v_writer, not pg_temp.ovd628_no_rows(p_k));
  perform pg_temp.ovd628_close('ovd628_req');
  perform pg_temp.ovd628_close(p_writer);
  perform pg_temp.ovd628_close('ovd628_driver');
end;
$$;

select pg_temp.ovd628_reversed_writer_race('R3', 15, 'ovd628_worker', pg_catalog.format(
  'select public.ovd628_worker_attempt(%L::uuid, %L)', pg_temp.ovd628_id('cad', 15),
  pg_catalog.md5('ovd628-cad-15') || pg_catalog.md5('ovd628-cad-tail-15')));
select pg_temp.ovd628_reversed_writer_race('R4', 16, 'ovd628_resetter',
  pg_temp.ovd628_client_sql('reset', pg_temp.ovd628_id('job', 16)));

select diag(race || ': writer_parked=' || coalesce(writer_parked::text, 'null')
  || ' request_state=' || coalesce(request_state, 'null')
  || ' request=' || coalesce(result::text, 'null') || ' writer=' || coalesce(writer::text, 'null'))
from ovd628_reversed order by race;

select ok((select writer_parked from ovd628_reversed where race = 'R3'),
  'R3: the worker''s trusted-hash call holds the CAD job_files row and is a Lock waiter on the driver''s part share');
select is((select request_state || ' ' || (result ->> 'sqlstate') || ' ' || (result ->> 'error')
    from ovd628_reversed where race = 'R3'),
  'finished P0001 provider_dispatch_job_busy',
  'R3: the request returns provider_dispatch_job_busy without a Lock wait on the worker');
select ok((select result ->> 'sqlstate' is distinct from '40P01' and writer ->> 'sqlstate' is null
      and (writer ->> 'registered')::boolean
    from ovd628_reversed where race = 'R3'),
  'R3: the worker finishes after the driver commits and no side sees 40P01');
select ok((select not rows_left from ovd628_reversed where race = 'R3'),
  'R3: the refused request leaves no permit, quote request or work queue row');

select ok((select writer_parked from ovd628_reversed where race = 'R4'),
  'R4: the client reset holds the requirement row and is a Lock waiter on the driver''s part share');
select is((select request_state || ' ' || (result ->> 'sqlstate') || ' ' || (result ->> 'error')
    from ovd628_reversed where race = 'R4'),
  'finished P0001 provider_dispatch_job_busy',
  'R4: the request returns provider_dispatch_job_busy without a Lock wait on the client reset');
select ok((select result ->> 'sqlstate' is distinct from '40P01' and writer ->> 'sqlstate' is null
      and writer ->> 'jobId' = pg_temp.ovd628_id('job', 16)::text
    from ovd628_reversed where race = 'R4'),
  'R4: the client reset commits after the driver commits and no side sees 40P01 (the client edit is never the victim)');
select ok((select not rows_left from ovd628_reversed where race = 'R4'),
  'R4: the refused request leaves no permit, quote request or work queue row');

-- Request-first races (R5a, R6, R7): the request holds its scope rows and is
-- parked on the driver's founding-beta lock; the client's writer then starts
-- and must be a Lock waiter blocked by the request. Neither side may see 40P01.
create temporary table ovd628_parked (race text primary key, request_parked boolean, writer_waited boolean,
  request jsonb, writer jsonb);

create function pg_temp.ovd628_parked_request_race(p_race text, p_k integer, p_writer_sql text)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_key constant bigint := pg_catalog.hashtextextended('founding-beta:' || pg_temp.ovd628_org()::text, 0);
  v_request_pid integer := pg_temp.ovd628_open('ovd628_req');
  v_writer_pid integer := pg_temp.ovd628_open('ovd628_canceller');
  v_driver_pid integer := pg_temp.ovd628_open('ovd628_driver');
  v_parked boolean;
  v_writer_waited boolean;
  v_result jsonb;
  v_writer jsonb;
begin
  perform * from extensions.dblink('ovd628_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_lock(%s)::text', v_key)) as remote(locked text);
  perform extensions.dblink_send_query('ovd628_req', pg_temp.ovd628_request_sql(p_k));
  v_parked := pg_temp.ovd628_blocked_by(v_request_pid, array[v_driver_pid]);
  perform extensions.dblink_send_query('ovd628_canceller', p_writer_sql);
  v_writer_waited := pg_temp.ovd628_blocked_by(v_writer_pid, array[v_request_pid]);
  perform * from extensions.dblink('ovd628_driver',
    pg_catalog.format('select pg_catalog.pg_advisory_unlock(%s)', v_key)) as remote(unlocked boolean);
  select result into v_result from extensions.dblink_get_result('ovd628_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_req', false) as response(result jsonb);
  select result into v_writer from extensions.dblink_get_result('ovd628_canceller', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_canceller', false) as response(result jsonb);
  insert into ovd628_parked values (p_race, v_parked, v_writer_waited, v_result, v_writer);
  perform pg_temp.ovd628_close('ovd628_req');
  perform pg_temp.ovd628_close('ovd628_canceller');
  perform pg_temp.ovd628_close('ovd628_driver');
end;
$$;

-- R5a: the archived job 21 is deleted while the request holds its rows.
select pg_temp.ovd628_parked_request_race('R5a', 21,
  pg_temp.ovd628_client_sql('delete_archived', pg_temp.ovd628_id('job', 21)));
-- R6: the client cancels the older request on job 17. The quote_requests
-- status sync updates the shared line item and waits on the request.
select pg_temp.ovd628_parked_request_race('R6', 17, pg_temp.ovd628_client_sql('cancel',
  (select request_row.id from public.quote_requests request_row
   where request_row.job_id = pg_temp.ovd628_id('job', 17)
     and request_row.requested_vendors = array['xometry']::public.vendor_name[])));
-- R7: job 20 belongs to a project and has no line item yet, so the request's
-- first line-item insert checks the project row; the owner deletes the
-- project, whose ON DELETE SET NULL on jobs.project_id needs the job row.
select pg_temp.ovd628_parked_request_race('R7', 20,
  pg_temp.ovd628_client_sql('delete_project', pg_temp.ovd628_id('project', 20)));

select diag(race || ': request_parked=' || coalesce(request_parked::text, 'null')
  || ' writer_waited=' || coalesce(writer_waited::text, 'null')
  || ' request=' || coalesce(request::text, 'null')
  || ' writer=' || coalesce(writer::text, 'null'))
from ovd628_parked order by race;

select ok((select request_parked and writer_waited from ovd628_parked where race = 'R5a'),
  'R5a: the request is parked after its locks and the client archived-job delete is a Lock waiter blocked by it');
select is((select coalesce(request ->> 'sqlstate', 'none') || ' ' || coalesce(request ->> 'error', 'none')
    from ovd628_parked where race = 'R5a'),
  'P0001 provider_dispatch_new_lane_required',
  'R5a: the request on the archived job is refused by the quote impl, not by 40P01 or busy');
select ok(
  coalesce((select writer ->> 'sqlstate' is null
      and writer -> 'deletedJobIds' = pg_catalog.jsonb_build_array(pg_temp.ovd628_id('job', 21))
    from ovd628_parked where race = 'R5a'), false)
  and not exists (select 1 from public.jobs where id = pg_temp.ovd628_id('job', 21)),
  'R5a: the client archived-job delete then commits and is never the 40P01 victim');

select ok((select request_parked and writer_waited from ovd628_parked where race = 'R6'),
  'R6: the request is parked after its locks and the client cancel of the older request is a Lock waiter blocked by it');
select ok(
  coalesce((select request ->> 'sqlstate' is null and (request ->> 'created')::boolean
    from ovd628_parked where race = 'R6'), false)
  and exists (select 1 from private.provider_dispatch_permits where job_id = pg_temp.ovd628_id('job', 17)),
  'R6: the request creates its dispatch and does not see 40P01');
select ok(
  coalesce((select writer ->> 'sqlstate' is null and (writer ->> 'canceled')::boolean
    from ovd628_parked where race = 'R6'), false)
  and exists (select 1 from public.quote_requests where job_id = pg_temp.ovd628_id('job', 17)
    and requested_vendors = array['xometry']::public.vendor_name[] and status = 'canceled'),
  'R6: the client cancel then commits and is never the 40P01 victim');

select ok((select request_parked and writer_waited from ovd628_parked where race = 'R7'),
  'R7: the request is parked after its locks and the client project delete is a Lock waiter blocked by it');
select ok(
  coalesce((select request ->> 'sqlstate' is null and (request ->> 'created')::boolean
    from ovd628_parked where race = 'R7'), false)
  and exists (select 1 from private.provider_dispatch_permits where job_id = pg_temp.ovd628_id('job', 20)),
  'R7: the request creates its dispatch and does not see 40P01');
select ok(
  coalesce((select writer ->> 'sqlstate' is null and writer ->> 'deleted' = pg_temp.ovd628_id('project', 20)::text
    from ovd628_parked where race = 'R7'), false)
  and not exists (select 1 from public.projects where id = pg_temp.ovd628_id('project', 20)),
  'R7: the client project delete then commits and is never the 40P01 victim');

-- Holder-first races (R5b, job-row strength): another session holds a row in
-- an open transaction; a fresh request must return busy without a Lock wait.
create temporary table ovd628_held (race text primary key, holder jsonb, request_state text, result jsonb,
  holder_commit text, rows_left boolean);

create function pg_temp.ovd628_held_row_race(p_race text, p_k integer, p_holder_sql text, p_commit boolean)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_pid integer := pg_temp.ovd628_open('ovd628_req');
  v_holder_pid integer := pg_temp.ovd628_open('ovd628_holder');
  v_holder jsonb;
  v_state text;
  v_result jsonb;
  v_end text := case when p_commit then 'commit' else 'rollback' end;
begin
  perform extensions.dblink_exec('ovd628_holder', 'begin');
  select result into v_holder from extensions.dblink('ovd628_holder', p_holder_sql) as remote(result jsonb);
  perform extensions.dblink_send_query('ovd628_req', pg_temp.ovd628_request_sql(p_k));
  v_state := pg_temp.ovd628_finished_or_waiting('ovd628_req', v_request_pid, array[v_holder_pid]);
  if v_state <> 'finished' then
    perform extensions.dblink_exec('ovd628_holder', v_end);
  end if;
  select result into v_result from extensions.dblink_get_result('ovd628_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_req', false) as response(result jsonb);
  if v_state = 'finished' then
    perform extensions.dblink_exec('ovd628_holder', v_end);
  end if;
  insert into ovd628_held values (p_race, v_holder, v_state, v_result, v_end, not pg_temp.ovd628_no_rows(p_k));
  perform pg_temp.ovd628_close('ovd628_req');
  perform pg_temp.ovd628_close('ovd628_holder');
end;
$$;

-- R5b: the client's archived-job delete holds job 22 in an open transaction.
select pg_temp.ovd628_held_row_race('R5b', 22,
  pg_temp.ovd628_client_sql('delete_archived', pg_temp.ovd628_id('job', 22)), true);
-- Job-row strength: a session holds job 19 FOR SHARE, as the preflight does.
select pg_temp.ovd628_held_row_race('job-share', 19, pg_catalog.format(
  'select pg_catalog.jsonb_build_object(%L, count(*)) from (select 1 from public.jobs where id = %L::uuid for share) held',
  'held', pg_temp.ovd628_id('job', 19)), false);

select diag(race || ': holder=' || coalesce(holder::text, 'null')
  || ' request_state=' || coalesce(request_state, 'null')
  || ' request=' || coalesce(result::text, 'null'))
from ovd628_held order by race;

select is((select request_state || ' ' || coalesce(result ->> 'sqlstate', 'none') || ' '
    || coalesce(result ->> 'error', 'none') from ovd628_held where race = 'R5b'),
  'finished P0001 provider_dispatch_job_busy',
  'R5b: while the client archived-job delete is open the request returns busy without a Lock wait');
select ok(
  coalesce((select holder ->> 'sqlstate' is null
      and holder -> 'deletedJobIds' = pg_catalog.jsonb_build_array(pg_temp.ovd628_id('job', 22))
    from ovd628_held where race = 'R5b'), false)
  and not exists (select 1 from public.jobs where id = pg_temp.ovd628_id('job', 22)),
  'R5b: the client archived-job delete commits and neither side sees 40P01');
select is((select request_state || ' ' || coalesce(result ->> 'sqlstate', 'none') || ' '
    || coalesce(result ->> 'error', 'none') from ovd628_held where race = 'job-share'),
  'finished P0001 provider_dispatch_job_busy',
  'Job row: a fresh request fails busy at once while another session holds the job FOR SHARE');
select ok((select not rows_left from ovd628_held where race = 'job-share'),
  'Job row: the refused request leaves no permit, quote request or work queue row');

-- Replay while busy: the dispatch on job 18 commits first. The worker's
-- trusted-hash call then holds the CAD job_files row and the part in an open
-- transaction. The exact replay finds its permit before any row lock and
-- returns the deduplicated result; a fresh approval for the same job is busy.
create temporary table ovd628_replay (first jsonb, worker jsonb, replay_state text, replay jsonb,
  fresh_state text, fresh jsonb, after jsonb, permits integer);

create function pg_temp.ovd628_replay_while_busy()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_pid integer := pg_temp.ovd628_open('ovd628_req');
  v_worker_pid integer := pg_temp.ovd628_open('ovd628_worker');
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
  from extensions.dblink('ovd628_req', pg_temp.ovd628_request_sql(18)) as response(result jsonb);
  perform extensions.dblink_exec('ovd628_worker', 'begin');
  select result into v_worker from extensions.dblink('ovd628_worker', pg_catalog.format(
    'select public.ovd628_worker_attempt(%L::uuid, %L)', pg_temp.ovd628_id('cad', 18),
    pg_catalog.md5('ovd628-cad-18') || pg_catalog.md5('ovd628-cad-tail-18'))) as response(result jsonb);
  perform extensions.dblink_send_query('ovd628_req', pg_temp.ovd628_request_sql(18));
  v_replay_state := pg_temp.ovd628_finished_or_waiting('ovd628_req', v_request_pid, array[v_worker_pid]);
  if v_replay_state <> 'finished' then
    perform extensions.dblink_exec('ovd628_worker', 'rollback');
    v_worker_open := false;
  end if;
  select result into v_replay from extensions.dblink_get_result('ovd628_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_req', false) as response(result jsonb);
  perform extensions.dblink_send_query('ovd628_req', pg_temp.ovd628_request_sql(18, 68));
  v_fresh_state := pg_temp.ovd628_finished_or_waiting('ovd628_req', v_request_pid, array[v_worker_pid]);
  if v_fresh_state <> 'finished' and v_worker_open then
    perform extensions.dblink_exec('ovd628_worker', 'rollback');
    v_worker_open := false;
  end if;
  select result into v_fresh from extensions.dblink_get_result('ovd628_req', false) as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd628_req', false) as response(result jsonb);
  if v_worker_open then
    perform extensions.dblink_exec('ovd628_worker', 'rollback');
  end if;
  select result into v_after
  from extensions.dblink('ovd628_req', pg_temp.ovd628_request_sql(18)) as response(result jsonb);
  insert into ovd628_replay values (v_first, v_worker, v_replay_state, v_replay, v_fresh_state, v_fresh, v_after,
    (select count(*)::integer from private.provider_dispatch_permits where job_id = pg_temp.ovd628_id('job', 18)));
  perform pg_temp.ovd628_close('ovd628_req');
  perform pg_temp.ovd628_close('ovd628_worker');
end;
$$;

select pg_temp.ovd628_replay_while_busy();

select diag('Replay: first_created=' || coalesce(first ->> 'created', 'null')
  || ' worker=' || coalesce(worker::text, 'null')
  || ' replay_state=' || coalesce(replay_state, 'null') || ' replay=' || coalesce(replay::text, 'null')
  || ' fresh_state=' || coalesce(fresh_state, 'null') || ' fresh=' || coalesce(fresh::text, 'null')
  || ' permits=' || coalesce(permits::text, 'null'))
from ovd628_replay;

select ok(coalesce((select (first ->> 'created')::boolean and (worker ->> 'registered')::boolean from ovd628_replay), false),
  'Replay: the dispatch commits, then the worker''s trusted-hash call holds the CAD and part rows in an open transaction');
select is((select replay_state || ' ' || coalesce(replay ->> 'deduplicated', 'null') || ' '
    || coalesce(replay ->> 'error', 'none') from ovd628_replay),
  'finished true none',
  'Replay: the exact replay returns the deduplicated result at once, never provider_dispatch_job_busy');
select ok(coalesce((select replay ->> 'permitId' = first ->> 'permitId'
    and after ->> 'permitId' = first ->> 'permitId' and (after ->> 'deduplicated')::boolean and permits = 1
  from ovd628_replay), false),
  'Replay: every replay returns the original permit and only one permit exists');
select is((select fresh_state || ' ' || coalesce(fresh ->> 'sqlstate', 'none') || ' ' || coalesce(fresh ->> 'error', 'none')
    from ovd628_replay),
  'finished P0001 provider_dispatch_job_busy',
  'Replay: a fresh approval for the same job is busy while the CAD and part rows are held');

-- Line-item strength: a session holds job 23's existing manufacturing_quote/
-- part line item FOR SHARE. Only a FOR NO KEY UPDATE NOWAIT line-item lock
-- conflicts with it; a FOR SHARE or KEY SHARE lock would let the request pass
-- the lock block and then queue at its line-item upsert. Its assertions follow
-- the final 40P01 check so the numbering of the earlier tests is unchanged;
-- that check already covers its outcome.
select pg_temp.ovd628_held_row_race('line-item-share', 23, pg_catalog.format(
  'select pg_catalog.jsonb_build_object(%L, count(*)) from (select 1 from public.service_request_line_items '
  || 'where job_id = %L::uuid and service_type = %L and scope = %L for share) held',
  'held', pg_temp.ovd628_id('job', 23), 'manufacturing_quote', 'part'), false);

select diag('Line item: holder=' || coalesce(holder::text, 'null')
  || ' request_state=' || coalesce(request_state, 'null')
  || ' request=' || coalesce(result::text, 'null'))
from ovd628_held where race = 'line-item-share';

-- No race left any session on 40P01 or a statement timeout.
select ok(not exists (
    select 1 from (
      select result as r from ovd628_outcomes union all select edit_result from ovd628_outcomes
      union all select fresh_result from ovd628_outcomes
      union all select result from ovd628_reversed union all select writer from ovd628_reversed
      union all select request from ovd628_parked union all select writer from ovd628_parked
      union all select result from ovd628_held union all select holder from ovd628_held
      union all select replay from ovd628_replay union all select fresh from ovd628_replay
    ) observed
    where observed.r ->> 'sqlstate' in ('40P01', '57014')),
  'No session in any race saw 40P01 or a statement timeout');

select is((select request_state || ' ' || coalesce(result ->> 'sqlstate', 'none') || ' '
    || coalesce(result ->> 'error', 'none') from ovd628_held where race = 'line-item-share'),
  'finished P0001 provider_dispatch_job_busy',
  'Line item: a fresh request fails busy at once while another session holds the job''s line item FOR SHARE');
select ok(coalesce((select holder ->> 'held' = '1' and not rows_left from ovd628_held where race = 'line-item-share'), false),
  'Line item: the held line item existed and the refused request leaves no permit, quote request or work queue row');

begin;
drop function public.ovd628_request_attempt(uuid, text, uuid);
drop function public.ovd628_edit_attempt(text);
drop function public.ovd628_worker_attempt(uuid, text);
drop function public.ovd628_client_attempt(text, uuid);
select public.ovd628_cleanup_admission_fixture();
commit;

drop function public.ovd628_cleanup_admission_fixture();

select * from finish();
