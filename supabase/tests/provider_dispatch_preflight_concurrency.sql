-- OVD-459 revocation-during-preflight races for the generic provider
-- preflight. Fixtures are committed so independent sessions contend on real
-- row and advisory locks. Each race holds a lock in this driver session, starts
-- the contenders in a fixed order, confirms through pg_stat_activity that both
-- are blocked on a lock, and only then releases. Every fixed row is removed and
-- the fictiv admission row is restored to its seeded default-off state before
-- finishing.

create extension if not exists dblink with schema extensions;

create or replace function public.ovd459_cleanup_concurrency_fixture()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_org constant uuid := '00000000-0000-4000-8000-0000000459e2'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
begin
  alter table private.provider_dispatch_permit_revocations disable trigger provider_dispatch_permit_revocations_append_only;
  delete from private.provider_dispatch_permit_revocations
  where permit_id in (select id from private.provider_dispatch_permits where organization_id = v_org);
  alter table private.provider_dispatch_permit_revocations enable trigger provider_dispatch_permit_revocations_append_only;
  alter table private.provider_dispatch_permits disable trigger provider_dispatch_permits_append_only;
  delete from private.provider_dispatch_permits where organization_id = v_org;
  alter table private.provider_dispatch_permits enable trigger provider_dispatch_permits_append_only;
  alter table private.provider_dispatch_envelope_reviews disable trigger guard_provider_dispatch_envelope_review_mutation;
  delete from private.provider_dispatch_envelope_reviews where envelope_id = 'fictiv-ovd459-race-envelope';
  alter table private.provider_dispatch_envelope_reviews enable trigger guard_provider_dispatch_envelope_review_mutation;

  alter table private.quote_provider_admission_policies disable trigger guard_quote_provider_admission_policy_mutation;
  alter table private.quote_provider_admission_policies disable trigger capture_quote_provider_admission_policy_history;
  update private.quote_provider_admission_policies
  set admission_state = 'disabled', generic_dispatch_enabled = false,
      policy_revision = 'disabled-2026-08-17.v1', evidence_reference = null, permission_basis = null,
      supported_processes = array[]::public.process_types[], accepted_file_extensions = array[]::text[],
      session_owner = null, reviewed_by = null, reviewed_at = null, expires_at = null,
      change_reason = 'initial_seed'
  where provider = 'fictiv' and policy_revision = 'fictiv-ovd459-race.v1';
  alter table private.quote_provider_admission_policies enable trigger capture_quote_provider_admission_policy_history;
  alter table private.quote_provider_admission_policies enable trigger guard_quote_provider_admission_policy_mutation;
  alter table private.quote_provider_admission_policy_history disable trigger reject_quote_provider_admission_history_mutation;
  delete from private.quote_provider_admission_policy_history
  where provider = 'fictiv' and policy_revision = 'fictiv-ovd459-race.v1';
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
  delete from auth.users where id = '00000000-0000-4000-8000-0000000459e1'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
  update private.commercial_rollout_controls
  set enabled = false, revision = 0,
      change_reason = 'Default-off automatic quote rollout',
      updated_by_user_id = null, updated_by_actor = null
  where capability = 'automatic_quote_collection';
end;
$$;

do $$
begin
  if 'ovd459_a' = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
    perform extensions.dblink_disconnect('ovd459_a');
  end if;
  if 'ovd459_b' = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
    perform extensions.dblink_disconnect('ovd459_b');
  end if;
end;
$$;
select public.ovd459_cleanup_concurrency_fixture();

select plan(9);

begin;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values ('00000000-0000-4000-8000-0000000459e1', 'authenticated', 'authenticated',
  'ovd459-concurrency@example.test', timezone('utc', now()));
insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-0000000459e2', 'OVD 459 Concurrency', 'ovd-459-concurrency');
insert into public.organization_memberships (organization_id, user_id, role)
values ('00000000-0000-4000-8000-0000000459e2', '00000000-0000-4000-8000-0000000459e1', 'client');
update public.organizations set shipping_same_as_billing = false, shipping_street = '123 Fixture Ave',
  shipping_city = 'Tucson', shipping_state = 'AZ', shipping_zip = '85701', shipping_country = 'US'
where id = '00000000-0000-4000-8000-0000000459e2';
insert into private.sourcing_destination_history (organization_id, state, address)
values ('00000000-0000-4000-8000-0000000459e2', 'confirmed',
  private.effective_sourcing_address('00000000-0000-4000-8000-0000000459e2'));
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason, granted_by_user_id
) values ('00000000-0000-4000-8000-0000000459e2', 'complimentary', now() - interval '1 day',
  now() + interval '30 days', 'OVD-459 concurrency fixture', '00000000-0000-4000-8000-0000000459e1');
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
) values ('00000000-0000-4000-8000-0000000459e2', '00000000-0000-4000-8000-0000000459e1', 'grant',
  'OVD-459 concurrency fixture', 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy',
  'ovd459-concurrency-grant');
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
values ('00000000-0000-4000-8000-0000000459e2', '00000000-0000-4000-8000-0000000459e1',
  'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy');
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
values ('00000000-0000-4000-8000-0000000459e2', 'fictiv', true);
update private.commercial_rollout_controls
set enabled = true, revision = revision + 1, change_reason = 'OVD-459 concurrency fixture'
where capability = 'automatic_quote_collection';
update private.quote_provider_admission_policies
set admission_state = 'approved', generic_dispatch_enabled = true,
  policy_revision = 'fictiv-ovd459-race.v1', evidence_reference = 'OVD-458',
  permission_basis = 'written_provider_authorization',
  supported_processes = array['cnc_milling']::public.process_types[],
  accepted_file_extensions = array['step', 'stp'], session_owner = 'overdrafter_managed',
  reviewed_by = '00000000-0000-4000-8000-0000000459e1', reviewed_at = now() - interval '1 day',
  expires_at = null, change_reason = 'approval_recorded'
where provider = 'fictiv';
insert into private.provider_dispatch_envelope_reviews (provider, envelope_id, envelope_version, evidence_reference, permit_ttl_seconds)
values ('fictiv', 'fictiv-ovd459-race-envelope', 1, 'OVD-459', 900);

do $$
declare
  v_index integer;
  v_job uuid;
begin
  for v_index in 1..2 loop
    v_job := ('00000000-0000-4000-8000-0000000459a' || v_index::text)::uuid;
    insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
    values (v_job, '00000000-0000-4000-8000-0000000459e2', '00000000-0000-4000-8000-0000000459e1',
      'Concurrent preflight part ' || v_index::text, 'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote');
    insert into public.organization_file_blobs (
      id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
    ) values (('00000000-0000-4000-8000-0000000459b' || v_index::text)::uuid, '00000000-0000-4000-8000-0000000459e2',
      repeat(v_index::text, 64), repeat(v_index::text, 64), 'job-files',
      'ovd459-concurrency/' || v_index::text || '.step', 100, 'application/step');
    insert into public.job_files (
      id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
      storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
    ) values (('00000000-0000-4000-8000-0000000459c' || v_index::text)::uuid, v_job,
      '00000000-0000-4000-8000-0000000459e2', '00000000-0000-4000-8000-0000000459e1',
      ('00000000-0000-4000-8000-0000000459b' || v_index::text)::uuid, repeat(v_index::text, 64),
      repeat(v_index::text, 64), 'job-files', 'ovd459-concurrency/' || v_index::text || '.step',
      'part-' || v_index::text || '.step', 'part-' || v_index::text, 'cad', 'application/step', 100);
    insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, quantity)
    values (('00000000-0000-4000-8000-0000000459d' || v_index::text)::uuid, v_job,
      '00000000-0000-4000-8000-0000000459e2', 'Part ' || v_index::text, 'part-' || v_index::text,
      ('00000000-0000-4000-8000-0000000459c' || v_index::text)::uuid, 1);
    insert into public.approved_part_requirements (
      part_id, organization_id, approved_by, material, finish, tightest_tolerance_inch, quantity,
      quote_quantities, applicable_vendors, spec_snapshot
    ) values (('00000000-0000-4000-8000-0000000459d' || v_index::text)::uuid, '00000000-0000-4000-8000-0000000459e2',
      '00000000-0000-4000-8000-0000000459e1', '6061-T6 Aluminum', 'As machined', 0.005, 1, array[1],
      array['fictiv']::public.vendor_name[], '{"process":"CNC milling"}'::jsonb);
  end loop;
end;
$$;

-- Runs the preflight exactly as the worker would: service_role, the claimed
-- task, its result, and the lane's staged scope.
create or replace function public.ovd459_preflight_attempt(p_permit_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_task_id uuid;
  v_result_id uuid;
  v_snapshot jsonb;
  v_claimed_at timestamptz;
  v_decision jsonb;
begin
  select permit.work_queue_task_id, permit.vendor_quote_result_id, lane.scope_snapshot, task.locked_at
  into strict v_task_id, v_result_id, v_snapshot, v_claimed_at
  from private.provider_dispatch_permits permit
  join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id
  join public.work_queue task on task.id = permit.work_queue_task_id
  where permit.id = p_permit_id;
  perform pg_catalog.set_config('role', 'service_role', true);
  v_decision := public.api_authorize_provider_worker_dispatch(
    v_task_id, v_result_id, v_snapshot, 'ovd459-race-worker', v_claimed_at
  );
  perform pg_catalog.set_config('role', 'none', true);
  return v_decision;
exception when others then
  return pg_catalog.jsonb_build_object('error', sqlerrm);
end;
$$;

-- Revokes as service_role. With a hold key, the revocation then stays
-- uncommitted until the driver releases that key.
create or replace function public.ovd459_revoke_attempt(p_permit_id uuid, p_hold_key text)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_revocation jsonb;
begin
  perform pg_catalog.set_config('role', 'service_role', true);
  v_revocation := private.revoke_provider_dispatch_permit(p_permit_id, 'operator_revoked');
  perform pg_catalog.set_config('role', 'none', true);
  if p_hold_key is not null then
    perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(p_hold_key, 0));
  end if;
  return v_revocation;
exception when others then
  return pg_catalog.jsonb_build_object('error', sqlerrm);
end;
$$;

commit;

select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000459e1","role":"authenticated","aal":"aal1"}', false);
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000459e1', false);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);

-- Mint and claim one permit per race.
create temporary table ovd459_permits (race text primary key, permit_id uuid not null);
begin;
insert into ovd459_permits
select race, (public.api_request_provider_dispatch(
  job_id, 'fictiv', 'inch',
  public.api_get_provider_dispatch_scope(job_id, 'fictiv', 'inch') ->> 'scopeFingerprint',
  'founding-beta-2026-08-15', 'fictiv-ovd459-race-envelope.v1', approval_reference, true, true, true
) ->> 'permitId')::uuid
from (values
  ('revocation_first', '00000000-0000-4000-8000-0000000459a1'::uuid, '00000000-0000-4000-8000-0000000459f1'::uuid),
  ('preflight_first', '00000000-0000-4000-8000-0000000459a2'::uuid, '00000000-0000-4000-8000-0000000459f2'::uuid)
) races(race, job_id, approval_reference);
update public.work_queue
set status = 'running', locked_at = date_trunc('milliseconds', now()), locked_by = 'ovd459-race-worker' -- NOSONAR: deterministic worker-claim fixture
where id in (select work_queue_task_id from private.provider_dispatch_permits
  where id in (select permit_id from ovd459_permits));
update public.vendor_quote_results set status = 'running'
where id in (select vendor_quote_result_id from private.provider_dispatch_permits
  where id in (select permit_id from ovd459_permits));
commit;

select pg_catalog.set_config('request.jwt.claims', '', false);
select pg_catalog.set_config('request.jwt.claim.sub', '', false);
select pg_catalog.set_config('request.jwt.claim.role', '', false);

select is(
  (select pg_catalog.count(*) from ovd459_permits permits
    where public.ovd459_preflight_attempt(permits.permit_id) -> 'authorized' = 'true'::jsonb),
  2::bigint,
  'both claimed race permits authorize before any revocation'
);

-- Waits until exactly p_count other sessions running an ovd459 attempt are
-- blocked on a lock; sequential completion can then not masquerade as a race.
create function pg_temp.wait_for_lock_waiters(p_count integer)
returns boolean
language plpgsql
set search_path = pg_catalog
as $$
begin
  for attempt in 1..250 loop
    perform pg_catalog.pg_stat_clear_snapshot();
    if (select pg_catalog.count(*) from pg_catalog.pg_stat_activity
        where pid <> pg_catalog.pg_backend_pid()
          and query like '%public.ovd459\_%\_attempt%'
          and wait_event_type = 'Lock') = p_count then
      return true;
    end if;
    perform pg_catalog.pg_sleep(0.02);
  end loop;
  return false;
end;
$$;

create temporary table ovd459_race_results (
  race text not null,
  contender text not null,
  both_waiting boolean not null,
  result jsonb not null,
  primary key (race, contender)
);

-- Holds p_lock_key, starts the first contender and waits until it is blocked,
-- starts the second and waits until both are blocked, then releases.
create function pg_temp.race(p_race text, p_lock_key text, p_first text, p_second text)
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_conninfo constant text := coalesce(
    nullif(current_setting('ovd.test_conninfo', true), ''),
    'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres' -- NOSONAR: ephemeral local Supabase fallback; override with ovd.test_conninfo elsewhere
  );
  v_first_waiting boolean;
  v_both_waiting boolean;
begin
  perform extensions.dblink_connect('ovd459_a', v_conninfo);
  perform extensions.dblink_connect('ovd459_b', v_conninfo);
  perform pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended(p_lock_key, 0));
  perform extensions.dblink_send_query('ovd459_a', p_first);
  v_first_waiting := pg_temp.wait_for_lock_waiters(1);
  perform extensions.dblink_send_query('ovd459_b', p_second);
  v_both_waiting := v_first_waiting and pg_temp.wait_for_lock_waiters(2);
  perform pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended(p_lock_key, 0));
  insert into ovd459_race_results
  select p_race, 'first', v_both_waiting, response.result
  from extensions.dblink_get_result('ovd459_a') as response(result jsonb);
  insert into ovd459_race_results
  select p_race, 'second', v_both_waiting, response.result
  from extensions.dblink_get_result('ovd459_b') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd459_a') as response(result jsonb);
  perform * from extensions.dblink_get_result('ovd459_b') as response(result jsonb);
  perform extensions.dblink_disconnect('ovd459_a');
  perform extensions.dblink_disconnect('ovd459_b');
end;
$$;

-- Race 1: a revocation is written but not yet committed (held on a driver
-- lock) when the preflight starts. The preflight blocks on the permit row and,
-- once the revocation commits, must observe it.
select pg_temp.race(
  'revocation_first',
  'ovd459-race:revocation-hold',
  format('select public.ovd459_revoke_attempt(%L::uuid, %L)',
    (select permit_id from ovd459_permits where race = 'revocation_first'), 'ovd459-race:revocation-hold'),
  format('select public.ovd459_preflight_attempt(%L::uuid)',
    (select permit_id from ovd459_permits where race = 'revocation_first'))
);

select ok(
  (select bool_and(both_waiting) from ovd459_race_results where race = 'revocation_first'),
  'the uncommitted revocation and the preflight were both blocked on locks before release'
);
select is(
  (select result ->> 'permitState' from ovd459_race_results where race = 'revocation_first' and contender = 'first'),
  'revoked', 'the held revocation committed once released'
);
select is(
  (select result from ovd459_race_results where race = 'revocation_first' and contender = 'second'),
  pg_catalog.jsonb_build_object('schema', 'provider-dispatch-authorization.v1', 'authorized', false,
    'denial', 'permit_revoked', 'retryable', false),
  'a preflight that waited on an in-flight revocation returns the terminal permit_revoked denial'
);

-- Race 2: the preflight has locked the task and permit and is held on the
-- Founding Beta lock when a revocation arrives. The revocation must wait for
-- the preflight's snapshot to finish, so the preflight is ordered first.
select pg_temp.race(
  'preflight_first',
  'founding-beta:00000000-0000-4000-8000-0000000459e2',
  format('select public.ovd459_preflight_attempt(%L::uuid)',
    (select permit_id from ovd459_permits where race = 'preflight_first')),
  format('select public.ovd459_revoke_attempt(%L::uuid, null)',
    (select permit_id from ovd459_permits where race = 'preflight_first'))
);

select ok(
  (select bool_and(both_waiting) from ovd459_race_results where race = 'preflight_first'),
  'the in-flight preflight and the revocation were both blocked on locks before release'
);
select is(
  (select result -> 'authorized' from ovd459_race_results where race = 'preflight_first' and contender = 'first'),
  'true'::jsonb, 'the preflight that locked the permit first completes against its consistent snapshot'
);
select is(
  (select result ->> 'permitState' from ovd459_race_results where race = 'preflight_first' and contender = 'second'),
  'revoked', 'the revocation that waited behind the preflight committed afterwards'
);
select is(
  (select public.ovd459_preflight_attempt(permit_id) ->> 'denial' from ovd459_permits where race = 'preflight_first'),
  'permit_revoked', 'every preflight after the revocation commits is denied'
);
select is(
  (select pg_catalog.count(*) from private.provider_dispatch_permit_revocations
    where permit_id in (select permit_id from ovd459_permits)),
  2::bigint, 'each race recorded exactly one revocation and the preflight wrote none'
);

begin;
drop function public.ovd459_preflight_attempt(uuid);
drop function public.ovd459_revoke_attempt(uuid, text);
select public.ovd459_cleanup_concurrency_fixture();
commit;

drop function public.ovd459_cleanup_concurrency_fixture();

select * from finish();
