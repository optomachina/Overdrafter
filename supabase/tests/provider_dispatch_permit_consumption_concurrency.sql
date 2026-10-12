-- OVD-734 concurrent consumption of one provider dispatch permit.
-- Two independent dblink sessions (the OVD-459 concurrency pattern) consume the
-- same permit while a third session holds the claimed task row, so both are
-- observed blocked on the row lock before release; sequential completion cannot
-- masquerade as a race. Exactly one consumer may be granted.
--
-- The draft (docs/migration-drafts/ovd-734.sql) is not in supabase/migrations,
-- and dblink sessions cannot see objects created inside an uncommitted test
-- transaction. While the consumption table is absent this file therefore COMMITS
-- the byte-copied draft fixture, and removes it at the end by running the
-- byte-copied rollback. The OVD-722 kill switch tables are stubbed the same way
-- (TEST STUB ONLY, created only when absent, dropped at the end). Fixture rows
-- are committed so the sessions can see them, and are all removed at the end.

create extension if not exists dblink with schema extensions;

select pg_catalog.to_regclass('private.provider_dispatch_permit_consumptions') is null as ovd734_race_install_draft \gset
\if :ovd734_race_install_draft
begin;
\ir fixtures/ovd734_provider_dispatch_permit_consumption.inc
commit;
\endif

-- TEST STUB ONLY: the subset of OVD-722 (PR #676) kill switch columns the draft
-- reads, under the exact OVD-722 names, created only while OVD-722 is not applied.
select pg_catalog.to_regclass('private.provider_kill_switches') is null
  and pg_catalog.to_regclass('private.provider_global_kill_switch') is null as ovd734_race_stub_switches \gset
\if :ovd734_race_stub_switches
begin;
create table private.provider_kill_switches (
  provider public.vendor_name primary key,
  engaged boolean not null default false
);
create table private.provider_global_kill_switch (
  singleton boolean primary key default true check (singleton),
  engaged boolean not null default false
);
revoke all on table private.provider_kill_switches from public, anon, authenticated, service_role;
revoke all on table private.provider_global_kill_switch from public, anon, authenticated, service_role;
insert into private.provider_kill_switches (provider, engaged)
select provider, false from pg_catalog.unnest(pg_catalog.enum_range(null::public.vendor_name)) as provider;
insert into private.provider_global_kill_switch (singleton, engaged) values (true, false);
commit;
\endif

create or replace function public.ovd734_cleanup_concurrency_fixture()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_org constant uuid := '00000000-0000-4000-8000-0000000734e2'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
begin
  if pg_catalog.to_regclass('private.provider_dispatch_permit_consumptions') is not null then
    alter table private.provider_dispatch_permit_consumptions
      disable trigger provider_dispatch_permit_consumptions_append_only;
    delete from private.provider_dispatch_permit_consumptions
    where permit_id in (select id from private.provider_dispatch_permits where organization_id = v_org);
    alter table private.provider_dispatch_permit_consumptions
      enable trigger provider_dispatch_permit_consumptions_append_only;
  end if;
  alter table private.provider_dispatch_permit_revocations disable trigger provider_dispatch_permit_revocations_append_only;
  delete from private.provider_dispatch_permit_revocations
  where permit_id in (select id from private.provider_dispatch_permits where organization_id = v_org);
  alter table private.provider_dispatch_permit_revocations enable trigger provider_dispatch_permit_revocations_append_only;
  alter table private.provider_dispatch_permits disable trigger provider_dispatch_permits_append_only;
  delete from private.provider_dispatch_permits where organization_id = v_org;
  alter table private.provider_dispatch_permits enable trigger provider_dispatch_permits_append_only;
  alter table private.provider_dispatch_envelope_reviews disable trigger guard_provider_dispatch_envelope_review_mutation;
  delete from private.provider_dispatch_envelope_reviews where envelope_id = 'fictiv-ovd734-race-envelope';
  update private.provider_dispatch_envelope_reviews set withdrawn_at = null
  where envelope_id = 'fictiv-quote-envelope' and envelope_version = 1 and evidence_reference = 'OVD-673';
  alter table private.provider_dispatch_envelope_reviews enable trigger guard_provider_dispatch_envelope_review_mutation;

  alter table private.quote_provider_admission_policies disable trigger guard_quote_provider_admission_policy_mutation;
  alter table private.quote_provider_admission_policies disable trigger capture_quote_provider_admission_policy_history;
  update private.quote_provider_admission_policies
  set admission_state = 'disabled', generic_dispatch_enabled = false,
      policy_revision = 'disabled-2026-08-17.v1', evidence_reference = null, permission_basis = null,
      supported_processes = array[]::public.process_types[], accepted_file_extensions = array[]::text[],
      session_owner = null, reviewed_by = null, reviewed_at = null, expires_at = null,
      change_reason = 'initial_seed'
  where provider = 'fictiv' and policy_revision = 'fictiv-ovd734-race.v1';
  alter table private.quote_provider_admission_policies enable trigger capture_quote_provider_admission_policy_history;
  alter table private.quote_provider_admission_policies enable trigger guard_quote_provider_admission_policy_mutation;
  alter table private.quote_provider_admission_policy_history disable trigger reject_quote_provider_admission_history_mutation;
  delete from private.quote_provider_admission_policy_history
  where provider = 'fictiv' and policy_revision = 'fictiv-ovd734-race.v1';
  alter table private.quote_provider_admission_policy_history enable trigger reject_quote_provider_admission_history_mutation;

  delete from public.audit_events where organization_id = v_org;
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
  delete from auth.users where id = '00000000-0000-4000-8000-0000000734e1'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
  update private.commercial_rollout_controls
  set enabled = false, revision = 0,
      change_reason = 'Default-off automatic quote rollout',
      updated_by_user_id = null, updated_by_actor = null
  where capability = 'automatic_quote_collection';
end;
$$;

do $$
begin
  if 'ovd734_a' = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
    perform extensions.dblink_disconnect('ovd734_a');
  end if;
  if 'ovd734_b' = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
    perform extensions.dblink_disconnect('ovd734_b');
  end if;
  if 'ovd734_hold' = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
    perform extensions.dblink_disconnect('ovd734_hold');
  end if;
end;
$$;
select public.ovd734_cleanup_concurrency_fixture();

select plan(13);

begin;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values ('00000000-0000-4000-8000-0000000734e1', 'authenticated', 'authenticated',
  'ovd734-concurrency@example.test', timezone('utc', now()));
insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-0000000734e2', 'OVD 734 Concurrency', 'ovd-734-concurrency');
insert into public.organization_memberships (organization_id, user_id, role)
values ('00000000-0000-4000-8000-0000000734e2', '00000000-0000-4000-8000-0000000734e1', 'client');
update public.organizations set shipping_same_as_billing = false, shipping_street = '123 Fixture Ave',
  shipping_city = 'Tucson', shipping_state = 'AZ', shipping_zip = '85701', shipping_country = 'US'
where id = '00000000-0000-4000-8000-0000000734e2';
insert into private.sourcing_destination_history (organization_id, state, address)
values ('00000000-0000-4000-8000-0000000734e2', 'confirmed',
  private.effective_sourcing_address('00000000-0000-4000-8000-0000000734e2'));
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason, granted_by_user_id
) values ('00000000-0000-4000-8000-0000000734e2', 'complimentary', now() - interval '1 day',
  now() + interval '30 days', 'OVD-734 concurrency fixture', '00000000-0000-4000-8000-0000000734e1');
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
) values ('00000000-0000-4000-8000-0000000734e2', '00000000-0000-4000-8000-0000000734e1', 'grant',
  'OVD-734 concurrency fixture', 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy',
  'ovd734-concurrency-grant');
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
values ('00000000-0000-4000-8000-0000000734e2', '00000000-0000-4000-8000-0000000734e1',
  'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy');
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
values ('00000000-0000-4000-8000-0000000734e2', 'fictiv', true);
update private.commercial_rollout_controls
set enabled = true, revision = revision + 1, change_reason = 'OVD-734 concurrency fixture'
where capability = 'automatic_quote_collection';
update private.quote_provider_admission_policies
set admission_state = 'approved', generic_dispatch_enabled = true,
  policy_revision = 'fictiv-ovd734-race.v1', evidence_reference = 'OVD-458',
  permission_basis = 'written_provider_authorization',
  supported_processes = array['cnc_milling']::public.process_types[],
  accepted_file_extensions = array['step', 'stp'], session_owner = 'overdrafter_managed',
  reviewed_by = '00000000-0000-4000-8000-0000000734e1', reviewed_at = now() - interval '1 day',
  expires_at = null, change_reason = 'approval_recorded'
where provider = 'fictiv';
-- Replace the OVD-673 migration envelope with this file's synthetic review.
update private.provider_dispatch_envelope_reviews set withdrawn_at = now()
where provider = 'fictiv' and withdrawn_at is null;
insert into private.provider_dispatch_envelope_reviews (provider, envelope_id, envelope_version, evidence_reference, permit_ttl_seconds)
values ('fictiv', 'fictiv-ovd734-race-envelope', 1, 'OVD-734', 900);

do $$
declare
  v_index integer;
  v_job uuid;
begin
  for v_index in 1..3 loop
    v_job := ('00000000-0000-4000-8000-0000000734a' || v_index::text)::uuid;
    insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
    values (v_job, '00000000-0000-4000-8000-0000000734e2', '00000000-0000-4000-8000-0000000734e1',
      'Concurrent consumption part ' || v_index::text, 'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote');
    insert into public.organization_file_blobs (
      id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
    ) values (('00000000-0000-4000-8000-0000000734b' || v_index::text)::uuid, '00000000-0000-4000-8000-0000000734e2',
      repeat(v_index::text, 64), repeat(v_index::text, 64), 'job-files',
      'ovd734-concurrency/' || v_index::text || '.step', 100, 'application/step');
    insert into public.job_files (
      id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
      storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
    ) values (('00000000-0000-4000-8000-0000000734c' || v_index::text)::uuid, v_job,
      '00000000-0000-4000-8000-0000000734e2', '00000000-0000-4000-8000-0000000734e1',
      ('00000000-0000-4000-8000-0000000734b' || v_index::text)::uuid, repeat(v_index::text, 64),
      repeat(v_index::text, 64), 'job-files', 'ovd734-concurrency/' || v_index::text || '.step',
      'part-' || v_index::text || '.step', 'part-' || v_index::text, 'cad', 'application/step', 100);
    insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, quantity)
    values (('00000000-0000-4000-8000-0000000734d' || v_index::text)::uuid, v_job,
      '00000000-0000-4000-8000-0000000734e2', 'Part ' || v_index::text, 'part-' || v_index::text,
      ('00000000-0000-4000-8000-0000000734c' || v_index::text)::uuid, 1);
    insert into public.approved_part_requirements (
      part_id, organization_id, approved_by, material, finish, tightest_tolerance_inch, quantity,
      quote_quantities, applicable_vendors, spec_snapshot
    ) values (('00000000-0000-4000-8000-0000000734d' || v_index::text)::uuid, '00000000-0000-4000-8000-0000000734e2',
      '00000000-0000-4000-8000-0000000734e1', '6061-T6 Aluminum', 'As machined', 0.005, 1, array[1],
      array['fictiv']::public.vendor_name[], '{"process":"CNC milling"}'::jsonb);
  end loop;
end;
$$;

-- Consumes exactly as the worker would: service_role, the claimed task, its
-- result, and the fingerprint from the task payload. Errors are returned as
-- their SQLSTATE so a lock timeout is data, not an aborted test.
create or replace function public.ovd734_consume_attempt(p_permit_id uuid, p_worker text)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_task_id uuid;
  v_result_id uuid;
  v_fingerprint text;
  v_decision jsonb;
begin
  select permit.work_queue_task_id, permit.vendor_quote_result_id,
    task.payload ->> 'providerDispatchEnvelopeFingerprint'
  into strict v_task_id, v_result_id, v_fingerprint
  from private.provider_dispatch_permits permit
  join public.work_queue task on task.id = permit.work_queue_task_id
  where permit.id = p_permit_id;
  perform pg_catalog.set_config('role', 'service_role', true);
  v_decision := public.api_consume_provider_dispatch_permit(
    v_task_id, v_result_id, p_permit_id, v_fingerprint, p_worker);
  perform pg_catalog.set_config('role', 'none', true);
  return v_decision;
exception when others then
  return pg_catalog.jsonb_build_object('error', sqlstate);
end;
$$;

create or replace function public.ovd734_record_attempt(p_permit_id uuid, p_attempt integer, p_worker text, p_outcome text)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_result jsonb;
begin
  perform pg_catalog.set_config('role', 'service_role', true);
  v_result := public.api_record_provider_dispatch_permit_outcome(p_permit_id, p_attempt, p_worker, p_outcome);
  perform pg_catalog.set_config('role', 'none', true);
  return v_result;
end;
$$;

commit;

select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000734e1","role":"authenticated","aal":"aal1"}', false);
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000734e1', false);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);

-- Mint and claim one permit per race.
create temporary table ovd734_permits (race text primary key, permit_id uuid not null, task_id uuid);
begin;
insert into ovd734_permits (race, permit_id)
select race, (public.api_request_provider_dispatch(
  job_id, 'fictiv', 'inch',
  public.api_get_provider_dispatch_scope(job_id, 'fictiv', 'inch') ->> 'scopeFingerprint',
  'founding-beta-2026-08-15', 'fictiv-ovd734-race-envelope.v1', approval_reference, true, true, true
) ->> 'permitId')::uuid
from (values
  ('first_consume', '00000000-0000-4000-8000-0000000734a1'::uuid, '00000000-0000-4000-8000-0000000734f1'::uuid),
  ('transient_retry', '00000000-0000-4000-8000-0000000734a2'::uuid, '00000000-0000-4000-8000-0000000734f2'::uuid),
  ('lock_timeout', '00000000-0000-4000-8000-0000000734a3'::uuid, '00000000-0000-4000-8000-0000000734f3'::uuid)
) races(race, job_id, approval_reference);
update ovd734_permits set task_id = permit.work_queue_task_id
from private.provider_dispatch_permits permit where permit.id = ovd734_permits.permit_id;
update public.work_queue
set status = 'running', locked_at = date_trunc('milliseconds', now()), locked_by = 'ovd734-race-worker' -- NOSONAR: deterministic worker-claim fixture
where id in (select task_id from ovd734_permits);
update public.vendor_quote_results set status = 'running'
where id in (select vendor_quote_result_id from private.provider_dispatch_permits
  where id in (select permit_id from ovd734_permits));
commit;

select pg_catalog.set_config('request.jwt.claims', '', false);
select pg_catalog.set_config('request.jwt.claim.sub', '', false);
select pg_catalog.set_config('request.jwt.claim.role', '', false);

select is(
  (select pg_catalog.count(*) from ovd734_permits permits
    join public.work_queue task on task.id = permits.task_id
    where task.status = 'running' and task.locked_by = 'ovd734-race-worker'),
  3::bigint,
  'every race permit is minted and its task claimed'
);

-- Waits until exactly p_count other sessions running a consume attempt are
-- blocked on a lock.
create function pg_temp.wait_for_lock_waiters(p_count integer)
returns boolean
language plpgsql
set search_path = pg_catalog
as $$
begin
  for attempt in 1..75 loop
    perform pg_catalog.pg_stat_clear_snapshot();
    if (select pg_catalog.count(*) from pg_catalog.pg_stat_activity
        where pid <> pg_catalog.pg_backend_pid()
          and query like '%public.ovd734\_consume\_attempt%'
          and wait_event_type = 'Lock') = p_count then
      return true;
    end if;
    perform pg_catalog.pg_sleep(0.02);
  end loop;
  return false;
end;
$$;

create temporary table ovd734_race_results (
  race text not null,
  contender text not null,
  both_waiting boolean not null,
  result jsonb not null,
  primary key (race, contender)
);

-- A third session holds the claimed task row FOR UPDATE (the first lock every
-- consume takes), the contenders are started and confirmed blocked on it, and
-- only then is the holder committed. With p_hold_past_timeout the holder keeps
-- the row until the single contender has returned.
create function pg_temp.race(p_race text, p_second boolean, p_hold_past_timeout boolean default false)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_conninfo constant text := coalesce(
    nullif(current_setting('ovd.test_conninfo', true), ''),
    'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres' -- NOSONAR: ephemeral local Supabase fallback; override with ovd.test_conninfo elsewhere
  );
  v_permit_id uuid;
  v_task_id uuid;
  v_attempt text;
  v_waiting boolean;
begin
  select permit_id, task_id into strict v_permit_id, v_task_id from ovd734_permits where race = p_race;
  v_attempt := format('select public.ovd734_consume_attempt(%L::uuid, %L)', v_permit_id, 'ovd734-race-worker');
  perform extensions.dblink_connect('ovd734_hold', v_conninfo);
  perform extensions.dblink_connect('ovd734_a', v_conninfo);
  perform extensions.dblink_connect('ovd734_b', v_conninfo);
  perform extensions.dblink_exec('ovd734_hold', 'begin');
  perform * from extensions.dblink('ovd734_hold',
    format('select 1 from public.work_queue where id = %L::uuid for update', v_task_id)) as held(one integer);
  perform extensions.dblink_send_query('ovd734_a', v_attempt);
  v_waiting := pg_temp.wait_for_lock_waiters(1);
  if p_second then
    perform extensions.dblink_send_query('ovd734_b', v_attempt);
    v_waiting := v_waiting and pg_temp.wait_for_lock_waiters(2);
  end if;
  if p_hold_past_timeout then
    for attempt in 1..250 loop
      exit when extensions.dblink_is_busy('ovd734_a') = 0;
      perform pg_catalog.pg_sleep(0.02);
    end loop;
  end if;
  perform extensions.dblink_exec('ovd734_hold', 'commit');
  insert into ovd734_race_results
  select p_race, 'a', v_waiting, response.result
  from extensions.dblink_get_result('ovd734_a') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd734_a') as response(result jsonb);
  if p_second then
    insert into ovd734_race_results
    select p_race, 'b', v_waiting, response.result
    from extensions.dblink_get_result('ovd734_b') as response(result jsonb);
    perform * from extensions.dblink_get_result('ovd734_b') as response(result jsonb);
  end if;
  perform extensions.dblink_disconnect('ovd734_a');
  perform extensions.dblink_disconnect('ovd734_b');
  perform extensions.dblink_disconnect('ovd734_hold');
end;
$$;

-- Race 1: two workers consume one fresh permit at the same instant.
select pg_temp.race('first_consume', true);

select ok((select bool_and(both_waiting) from ovd734_race_results where race = 'first_consume'),
  'both consumers were blocked on the claimed task row before release');
select is(
  (select pg_catalog.count(*) from ovd734_race_results
    where race = 'first_consume' and result -> 'consumed' = 'true'::jsonb and result -> 'attempt' = '1'::jsonb),
  1::bigint, 'exactly one concurrent consumer is granted attempt 1');
select is(
  (select pg_catalog.count(*) from ovd734_race_results
    where race = 'first_consume' and result ->> 'denial' = 'permit_already_consumed'),
  1::bigint, 'the other concurrent consumer is refused with permit_already_consumed');
select is(
  (select pg_catalog.count(*) from private.provider_dispatch_permit_consumptions
    where permit_id = (select permit_id from ovd734_permits where race = 'first_consume')),
  1::bigint, 'exactly one consumption row exists for the raced permit');

-- Race 2: attempt 1 failed transiently; two requeued consumers race for the one retry.
select public.ovd734_consume_attempt(permit_id, 'ovd734-race-worker')
from ovd734_permits where race = 'transient_retry';
-- Recording succeeds only for an existing, unstamped attempt 1 of this worker.
select is(
  (select public.ovd734_record_attempt(permit_id, 1, 'ovd734-race-worker', 'transient_pre_launch_failure') -> 'outcomeRecorded'
   from ovd734_permits where race = 'transient_retry'),
  'true'::jsonb, 'fixture: attempt 1 is consumed and recorded as a transient pre-launch failure');
select pg_temp.race('transient_retry', true);

select ok((select bool_and(both_waiting) from ovd734_race_results where race = 'transient_retry'),
  'both retry consumers were blocked on the claimed task row before release');
select is(
  (select pg_catalog.count(*) from ovd734_race_results
    where race = 'transient_retry' and result -> 'consumed' = 'true'::jsonb and result -> 'attempt' = '2'::jsonb),
  1::bigint, 'exactly one concurrent retry is granted attempt 2');
select is(
  (select pg_catalog.count(*) from ovd734_race_results
    where race = 'transient_retry' and result ->> 'denial' = 'permit_already_consumed'),
  1::bigint, 'the other concurrent retry is refused with permit_already_consumed');
select is(
  (select pg_catalog.array_agg(attempt order by attempt) from private.provider_dispatch_permit_consumptions
    where permit_id = (select permit_id from ovd734_permits where race = 'transient_retry')),
  array[1, 2]::smallint[], 'the retried permit holds exactly attempts 1 and 2');

-- Race 3: a stuck holder makes the consumer fail fast with lock_timeout and record nothing.
select pg_temp.race('lock_timeout', false, true);

select is(
  (select result from ovd734_race_results where race = 'lock_timeout' and contender = 'a'),
  '{"error": "55P03"}'::jsonb, 'a consumer blocked past the 2s lock_timeout fails with 55P03 (fail closed)');
select is(
  (select pg_catalog.count(*) from private.provider_dispatch_permit_consumptions
    where permit_id = (select permit_id from ovd734_permits where race = 'lock_timeout')),
  0::bigint, 'the timed-out consumer recorded nothing');

begin;
drop function public.ovd734_consume_attempt(uuid, text);
drop function public.ovd734_record_attempt(uuid, integer, text, text);
select public.ovd734_cleanup_concurrency_fixture();
commit;
drop function public.ovd734_cleanup_concurrency_fixture();

-- Remove the committed draft with its own rollback (no consumption rows remain,
-- so its guard admits it), then the kill switch stubs.
\if :ovd734_race_install_draft
begin;
\ir fixtures/ovd734_provider_dispatch_permit_consumption_rollback.inc
commit;
\endif
\if :ovd734_race_stub_switches
begin;
drop table private.provider_kill_switches;
drop table private.provider_global_kill_switch;
commit;
\endif

select ok(
  (pg_catalog.to_regclass('private.provider_dispatch_permit_consumptions') is null) = :'ovd734_race_install_draft'::boolean
  and (pg_catalog.to_regclass('private.provider_global_kill_switch') is null) = :'ovd734_race_stub_switches'::boolean,
  'the draft and any kill switch stubs this file committed are removed; promoted objects are left in place'
);

select * from finish();
