-- OVD-458 two-session replay and approval-reference races for the generic
-- provider dispatch permit. Fixtures are committed so independent sessions can
-- contend on the real advisory locks; every fixed row is removed and the fictiv
-- admission row is restored to its seeded default-off state before finishing.

create extension if not exists dblink with schema extensions;

create or replace function public.ovd458_cleanup_concurrency_fixture()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_org constant uuid := '00000000-0000-4000-8000-000000004602'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
begin
  alter table private.provider_dispatch_permits disable trigger provider_dispatch_permits_append_only;
  delete from private.provider_dispatch_permits where organization_id = v_org;
  alter table private.provider_dispatch_permits enable trigger provider_dispatch_permits_append_only;
  alter table private.provider_dispatch_envelope_reviews disable trigger guard_provider_dispatch_envelope_review_mutation;
  delete from private.provider_dispatch_envelope_reviews where envelope_id = 'fictiv-ovd458-race-envelope';
  alter table private.provider_dispatch_envelope_reviews enable trigger guard_provider_dispatch_envelope_review_mutation;

  alter table private.quote_provider_admission_policies disable trigger guard_quote_provider_admission_policy_mutation;
  alter table private.quote_provider_admission_policies disable trigger capture_quote_provider_admission_policy_history;
  update private.quote_provider_admission_policies
  set admission_state = 'disabled', generic_dispatch_enabled = false,
      policy_revision = 'disabled-2026-08-17.v1', evidence_reference = null, permission_basis = null,
      supported_processes = array[]::public.process_types[], accepted_file_extensions = array[]::text[],
      session_owner = null, reviewed_by = null, reviewed_at = null, expires_at = null,
      change_reason = 'initial_seed'
  where provider = 'fictiv' and policy_revision = 'fictiv-ovd458-race.v1';
  alter table private.quote_provider_admission_policies enable trigger capture_quote_provider_admission_policy_history;
  alter table private.quote_provider_admission_policies enable trigger guard_quote_provider_admission_policy_mutation;
  alter table private.quote_provider_admission_policy_history disable trigger reject_quote_provider_admission_history_mutation;
  delete from private.quote_provider_admission_policy_history
  where provider = 'fictiv' and policy_revision = 'fictiv-ovd458-race.v1';
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
  delete from auth.users where id = '00000000-0000-4000-8000-000000004601'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
  update private.commercial_rollout_controls
  set enabled = false, revision = 0,
      change_reason = 'Default-off automatic quote rollout',
      updated_by_user_id = null, updated_by_actor = null
  where capability = 'automatic_quote_collection';
end;
$$;

do $$
begin
  if 'ovd458_a' = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
    perform extensions.dblink_disconnect('ovd458_a');
  end if;
  if 'ovd458_b' = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
    perform extensions.dblink_disconnect('ovd458_b');
  end if;
end;
$$;
select public.ovd458_cleanup_concurrency_fixture();

select plan(15);

begin;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values ('00000000-0000-4000-8000-000000004601', 'authenticated', 'authenticated',
  'ovd458-concurrency@example.test', timezone('utc', now()));
insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-000000004602', 'OVD 458 Concurrency', 'ovd-458-concurrency');
insert into public.organization_memberships (organization_id, user_id, role)
values ('00000000-0000-4000-8000-000000004602', '00000000-0000-4000-8000-000000004601', 'client');
update public.organizations set shipping_same_as_billing = false, shipping_street = '123 Fixture Ave',
  shipping_city = 'Tucson', shipping_state = 'AZ', shipping_zip = '85701', shipping_country = 'US'
where id = '00000000-0000-4000-8000-000000004602';
insert into private.sourcing_destination_history (organization_id, state, address)
values ('00000000-0000-4000-8000-000000004602', 'confirmed',
  private.effective_sourcing_address('00000000-0000-4000-8000-000000004602'));
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason, granted_by_user_id
) values ('00000000-0000-4000-8000-000000004602', 'complimentary', now() - interval '1 day',
  now() + interval '30 days', 'OVD-458 concurrency fixture', '00000000-0000-4000-8000-000000004601');
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
) values ('00000000-0000-4000-8000-000000004602', '00000000-0000-4000-8000-000000004601', 'grant',
  'OVD-458 concurrency fixture', 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy',
  'ovd458-concurrency-grant');
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
values ('00000000-0000-4000-8000-000000004602', '00000000-0000-4000-8000-000000004601',
  'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy');
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
values ('00000000-0000-4000-8000-000000004602', 'fictiv', true);
update private.commercial_rollout_controls
set enabled = true, revision = revision + 1, change_reason = 'OVD-458 concurrency fixture'
where capability = 'automatic_quote_collection';
update private.quote_provider_admission_policies
set admission_state = 'approved', generic_dispatch_enabled = true,
  policy_revision = 'fictiv-ovd458-race.v1', evidence_reference = 'OVD-458',
  permission_basis = 'written_provider_authorization',
  supported_processes = array['cnc_milling']::public.process_types[],
  accepted_file_extensions = array['step', 'stp'], session_owner = 'overdrafter_managed',
  reviewed_by = '00000000-0000-4000-8000-000000004601', reviewed_at = now() - interval '1 day',
  expires_at = null, change_reason = 'approval_recorded'
where provider = 'fictiv';
insert into private.provider_dispatch_envelope_reviews (provider, envelope_id, envelope_version, evidence_reference, permit_ttl_seconds)
values ('fictiv', 'fictiv-ovd458-race-envelope', 1, 'OVD-458', 900);

do $$
declare
  v_index integer;
  v_job uuid;
begin
  for v_index in 1..5 loop
    v_job := ('00000000-0000-4000-8000-00000000462' || v_index::text)::uuid;
    insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
    values (v_job, '00000000-0000-4000-8000-000000004602', '00000000-0000-4000-8000-000000004601',
      'Concurrent generic part ' || v_index::text, 'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote');
    insert into public.organization_file_blobs (
      id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
    ) values (('00000000-0000-4000-8000-00000000463' || v_index::text)::uuid, '00000000-0000-4000-8000-000000004602',
      repeat(v_index::text, 64), repeat(v_index::text, 64), 'job-files',
      'ovd458-concurrency/' || v_index::text || '.step', 100, 'application/step');
    insert into public.job_files (
      id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
      storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
    ) values (('00000000-0000-4000-8000-00000000464' || v_index::text)::uuid, v_job,
      '00000000-0000-4000-8000-000000004602', '00000000-0000-4000-8000-000000004601',
      ('00000000-0000-4000-8000-00000000463' || v_index::text)::uuid, repeat(v_index::text, 64),
      repeat(v_index::text, 64), 'job-files', 'ovd458-concurrency/' || v_index::text || '.step',
      'part-' || v_index::text || '.step', 'part-' || v_index::text, 'cad', 'application/step', 100);
    insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, quantity)
    values (('00000000-0000-4000-8000-00000000465' || v_index::text)::uuid, v_job,
      '00000000-0000-4000-8000-000000004602', 'Part ' || v_index::text, 'part-' || v_index::text,
      ('00000000-0000-4000-8000-00000000464' || v_index::text)::uuid, 1);
    insert into public.approved_part_requirements (
      part_id, organization_id, approved_by, material, finish, tightest_tolerance_inch, quantity,
      quote_quantities, applicable_vendors, spec_snapshot
    ) values (('00000000-0000-4000-8000-00000000465' || v_index::text)::uuid, '00000000-0000-4000-8000-000000004602',
      '00000000-0000-4000-8000-000000004601', '6061-T6 Aluminum', 'As machined', 0.005, 1, array[1],
      array['fictiv']::public.vendor_name[], '{"process":"CNC milling"}'::jsonb);
  end loop;
end;
$$;

create or replace function public.ovd458_concurrency_attempt(
  p_job_id uuid,
  p_scope_fingerprint text,
  p_approval_reference uuid
) returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000004601","role":"authenticated","aal":"aal1"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000004601', true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  begin
    return public.api_request_provider_dispatch(
      p_job_id, 'fictiv', 'inch', p_scope_fingerprint, 'founding-beta-2026-08-15',
      'fictiv-ovd458-race-envelope.v1', p_approval_reference, true, true, true
    );
  exception when others then
    return pg_catalog.jsonb_build_object('error', sqlerrm);
  end;
end;
$$;

commit;

select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000004601","role":"authenticated","aal":"aal1"}', false);
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000004601', false);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);

create temporary table ovd458_scopes (job_id uuid primary key, scope_fingerprint text not null);
insert into ovd458_scopes
select job_id, public.api_get_provider_dispatch_scope(job_id, 'fictiv', 'inch') ->> 'scopeFingerprint'
from (values ('00000000-0000-4000-8000-000000004621'::uuid),
  ('00000000-0000-4000-8000-000000004622'::uuid),
  ('00000000-0000-4000-8000-000000004623'::uuid),
  ('00000000-0000-4000-8000-000000004624'::uuid),
  ('00000000-0000-4000-8000-000000004625'::uuid)) jobs(job_id);

-- Both contenders must be blocked on the held lock before it is released;
-- otherwise sequential success could masquerade as a race.
create function pg_temp.wait_for_lock_waiters(p_pattern text, p_count integer)
returns boolean
language plpgsql
set search_path = pg_catalog
as $$
begin
  for attempt in 1..250 loop
    perform pg_catalog.pg_stat_clear_snapshot();
    if (select pg_catalog.count(*) from pg_catalog.pg_stat_activity
        where pid <> pg_catalog.pg_backend_pid()
          and query like p_pattern
          and wait_event_type = 'Lock') = p_count then
      return true;
    end if;
    perform pg_catalog.pg_sleep(0.02);
  end loop;
  return false;
end;
$$;

create function pg_temp.wait_for_two_contenders()
returns boolean
language sql
set search_path = pg_catalog
as $$
  select pg_temp.wait_for_lock_waiters('%ovd458_concurrency_attempt%', 2);
$$;

create temporary table ovd458_race_barriers (race text primary key, both_waiting boolean not null);

-- Holds p_lock_key (a key the RPC takes before any write), starts both
-- contenders, records whether both are waiting on it, then releases it.
create function pg_temp.race(p_race text, p_lock_key text, p_job_a uuid, p_job_b uuid, p_reference uuid)
returns setof jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_conninfo constant text := coalesce(
    nullif(current_setting('ovd.test_conninfo', true), ''),
    'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres' -- NOSONAR: ephemeral local Supabase fallback; override with ovd.test_conninfo elsewhere
  );
begin
  perform extensions.dblink_connect('ovd458_a', v_conninfo);
  perform extensions.dblink_connect('ovd458_b', v_conninfo);
  perform pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended(p_lock_key, 0));
  perform extensions.dblink_send_query('ovd458_a', format(
    'select public.ovd458_concurrency_attempt(%L::uuid, %L, %L::uuid)',
    p_job_a, (select scope_fingerprint from ovd458_scopes where job_id = p_job_a), p_reference));
  perform extensions.dblink_send_query('ovd458_b', format(
    'select public.ovd458_concurrency_attempt(%L::uuid, %L, %L::uuid)',
    p_job_b, (select scope_fingerprint from ovd458_scopes where job_id = p_job_b), p_reference));
  insert into ovd458_race_barriers values (p_race, pg_temp.wait_for_two_contenders());
  perform pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended(p_lock_key, 0));
  return query select result from extensions.dblink_get_result('ovd458_a') as response(result jsonb);
  return query select result from extensions.dblink_get_result('ovd458_b') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd458_a') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd458_b') as response(result jsonb);
  perform extensions.dblink_disconnect('ovd458_a');
  perform extensions.dblink_disconnect('ovd458_b');
end;
$$;

-- Race 1: the exact same request from two sessions is idempotent. Both wait
-- on the job's quote-lane-submit lock held by this driver session.
create temporary table ovd458_replay_results (result jsonb not null);
insert into ovd458_replay_results
select * from pg_temp.race('replay',
  'quote-lane-submit:00000000-0000-4000-8000-000000004621',
  '00000000-0000-4000-8000-000000004621',
  '00000000-0000-4000-8000-000000004621', '00000000-0000-4000-8000-000000004611');

select ok((select both_waiting from ovd458_race_barriers where race = 'replay'),
  'both identical replays were blocked on the held job lock before release');
select is(
  (select count(*) from ovd458_replay_results where (result ->> 'created')::boolean),
  1::bigint, 'two sessions replaying one exact request create exactly one dispatch');
select is(
  (select count(*) from ovd458_replay_results
    where (result ->> 'deduplicated')::boolean
      and result ->> 'permitId' = (select result ->> 'permitId' from ovd458_replay_results
        where (result ->> 'created')::boolean)),
  1::bigint, 'the waiting session receives the same permit as an idempotent replay');

-- Race 2: one approval reference racing across two jobs creates one dispatch.
-- Both wait on the organization-scoped approval lock held by this session.
create temporary table ovd458_conflict_results (result jsonb not null);
insert into ovd458_conflict_results
select * from pg_temp.race('conflict',
  'xometry-beta-approval:00000000-0000-4000-8000-000000004602:00000000-0000-4000-8000-000000004612',
  '00000000-0000-4000-8000-000000004622',
  '00000000-0000-4000-8000-000000004623', '00000000-0000-4000-8000-000000004612');

select ok((select both_waiting from ovd458_race_barriers where race = 'conflict'),
  'both cross-job requests were blocked on the held approval lock before release');
select is(
  (select count(*) from ovd458_conflict_results where (result ->> 'created')::boolean),
  1::bigint, 'two jobs racing one approval reference create exactly one dispatch');
select is(
  (select count(*) from ovd458_conflict_results
    where result ->> 'error' = 'provider_dispatch_approval_reference_reused'),
  1::bigint, 'the losing cross-job request returns the deterministic approval conflict');

select is(
  (select count(*) from private.provider_dispatch_permits
    where organization_id = '00000000-0000-4000-8000-000000004602'),
  2::bigint, 'the two races left exactly two permits');
select ok(
  (select count(*) = 2 from public.work_queue task
    join private.provider_dispatch_permits permit on permit.work_queue_task_id = task.id
    where task.payload ->> 'providerDispatchPermitId' = permit.id::text
      and permit.organization_id = '00000000-0000-4000-8000-000000004602')
  and (select count(*) = 2 from public.quote_requests
    where organization_id = '00000000-0000-4000-8000-000000004602'),
  'each permit has exactly one bound task and no losing request left partial work'
);

-- Race 3: a requirement edit that holds its row lock first is validated
-- after it commits, so the request is refused and persists no work.
create temporary table ovd458_requirement_races (name text primary key, result jsonb, waited boolean, editor_waited boolean);
create function pg_temp.edit_first_race()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_conninfo constant text := coalesce(
    nullif(current_setting('ovd.test_conninfo', true), ''),
    'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres' -- NOSONAR: ephemeral local Supabase fallback; override with ovd.test_conninfo elsewhere
  );
  v_waited boolean;
  v_result jsonb;
begin
  perform extensions.dblink_connect('ovd458_editor', v_conninfo);
  perform extensions.dblink_connect('ovd458_a', v_conninfo);
  perform extensions.dblink_exec('ovd458_editor', 'begin');
  perform extensions.dblink_exec('ovd458_editor', $sql$update public.approved_part_requirements
    set spec_snapshot = '{"process":"laser cutting"}'::jsonb
    where part_id = '00000000-0000-4000-8000-000000004654'$sql$);
  perform extensions.dblink_send_query('ovd458_a', format(
    'select public.ovd458_concurrency_attempt(%L::uuid, %L, %L::uuid)',
    '00000000-0000-4000-8000-000000004624',
    (select scope_fingerprint from ovd458_scopes where job_id = '00000000-0000-4000-8000-000000004624'),
    '00000000-0000-4000-8000-000000004613'));
  v_waited := pg_temp.wait_for_lock_waiters('%ovd458_concurrency_attempt%', 1);
  perform extensions.dblink_exec('ovd458_editor', 'commit');
  select result into v_result from extensions.dblink_get_result('ovd458_a') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd458_a') as response(result jsonb);
  insert into ovd458_requirement_races values ('edit-first', v_result, v_waited, null);
  perform extensions.dblink_disconnect('ovd458_editor');
  perform extensions.dblink_disconnect('ovd458_a');
end;
$$;
select pg_temp.edit_first_race();

select ok((select waited from ovd458_requirement_races where name = 'edit-first'),
  'the request was blocked on the uncommitted requirement edit');
select is((select result ->> 'error' from ovd458_requirement_races where name = 'edit-first'),
  'provider_dispatch_process_not_admitted',
  'the request validates the committed edit and refuses the non-admitted process');
select ok(
  not exists (select 1 from private.provider_dispatch_permits where job_id = '00000000-0000-4000-8000-000000004624')
  and not exists (select 1 from public.quote_requests where job_id = '00000000-0000-4000-8000-000000004624')
  and not exists (select 1 from public.work_queue where job_id = '00000000-0000-4000-8000-000000004624'),
  'the refused request persisted no request, task, or permit');

-- Race 4: once the request holds its scope rows, a requirement edit waits for
-- the permit transaction, so the permit binds only what passed validation.
-- The driver pauses the request after its row locks on the Founding Beta lock.
create function pg_temp.request_first_race()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_conninfo constant text := coalesce(
    nullif(current_setting('ovd.test_conninfo', true), ''),
    'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres' -- NOSONAR: ephemeral local Supabase fallback; override with ovd.test_conninfo elsewhere
  );
  v_key constant bigint := pg_catalog.hashtextextended('founding-beta:00000000-0000-4000-8000-000000004602', 0);
  v_waited boolean;
  v_editor_waited boolean;
  v_result jsonb;
begin
  perform extensions.dblink_connect('ovd458_editor', v_conninfo);
  perform extensions.dblink_connect('ovd458_a', v_conninfo);
  perform pg_catalog.pg_advisory_lock(v_key);
  perform extensions.dblink_send_query('ovd458_a', format(
    'select public.ovd458_concurrency_attempt(%L::uuid, %L, %L::uuid)',
    '00000000-0000-4000-8000-000000004625',
    (select scope_fingerprint from ovd458_scopes where job_id = '00000000-0000-4000-8000-000000004625'),
    '00000000-0000-4000-8000-000000004614'));
  v_waited := pg_temp.wait_for_lock_waiters('%ovd458_concurrency_attempt%', 1);
  perform extensions.dblink_send_query('ovd458_editor', $sql$update public.approved_part_requirements
    set spec_snapshot = '{"process":"laser cutting"}'::jsonb
    where part_id = '00000000-0000-4000-8000-000000004655'$sql$);
  v_editor_waited := pg_temp.wait_for_lock_waiters('%update public.approved_part_requirements%', 1);
  perform pg_catalog.pg_advisory_unlock(v_key);
  select result into v_result from extensions.dblink_get_result('ovd458_a') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd458_a') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd458_editor') as response(status text);
  perform * from extensions.dblink_get_result('ovd458_editor') as response(status text);
  insert into ovd458_requirement_races values ('request-first', v_result, v_waited, v_editor_waited);
  perform extensions.dblink_disconnect('ovd458_editor');
  perform extensions.dblink_disconnect('ovd458_a');
end;
$$;
select pg_temp.request_first_race();

select ok((select waited from ovd458_requirement_races where name = 'request-first'),
  'the request was paused after taking its scope row locks');
select ok((select editor_waited from ovd458_requirement_races where name = 'request-first'),
  'the concurrent requirement edit waited on the request''s row locks');
select ok((select (result ->> 'created')::boolean from ovd458_requirement_races where name = 'request-first'),
  'the request completed on the requirements it validated');
select ok(
  (select lane.scope_snapshot #>> '{requirements,specification,process}' = 'CNC milling'
   from private.provider_dispatch_permits permit
   join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
   where permit.job_id = '00000000-0000-4000-8000-000000004625')
  and (select spec_snapshot ->> 'process' = 'laser cutting' from public.approved_part_requirements
       where part_id = '00000000-0000-4000-8000-000000004655'),
  'the permit binds the validated requirements and the edit applied only afterwards');

begin;
drop function public.ovd458_concurrency_attempt(uuid, text, uuid);
select public.ovd458_cleanup_concurrency_fixture();
commit;

drop function public.ovd458_cleanup_concurrency_fixture();

select * from finish();
