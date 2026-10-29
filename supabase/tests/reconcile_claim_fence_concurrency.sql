-- S1.1b local two-session races. Committed synthetic fixtures are gated by
-- pg_stat_activity evidence, bounded statement timeouts, and explicit cleanup.
create extension if not exists dblink with schema extensions;
-- Refuse collisions instead of deleting any pre-existing fixture.
do $$ begin
 if exists(select 1 from public.organizations where id in
 ('00000000-0000-4000-8000-0000001199e2','00000000-0000-4000-8000-000000008812')) then
  raise exception 's11b fixture ownership collision';
 end if;
end $$;
create temporary table s11b_control_before as select to_jsonb(c) row from private.commercial_rollout_controls c;
create temporary table s11b_policy_before as select to_jsonb(p) row from private.quote_provider_admission_policies p where provider='fictiv';
create temporary table s11b_envelope_before as select id,withdrawn_at from private.provider_dispatch_envelope_reviews where provider='fictiv';
create temporary table s11b_switch_before as select * from private.provider_kill_switches where provider='fictiv';


create or replace function public.s11b_cleanup_concurrency_fixture()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_org constant uuid := '00000000-0000-4000-8000-0000001199e2'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
begin
  alter table private.provider_dispatch_permit_revocations disable trigger provider_dispatch_permit_revocations_append_only;
  delete from private.provider_dispatch_permit_revocations
  where permit_id in (select id from private.provider_dispatch_permits where organization_id = v_org);
  alter table private.provider_dispatch_permit_revocations enable trigger provider_dispatch_permit_revocations_append_only;
  alter table private.provider_dispatch_permits disable trigger provider_dispatch_permits_append_only;
  delete from private.provider_dispatch_permits where organization_id = v_org;
  alter table private.provider_dispatch_permits enable trigger provider_dispatch_permits_append_only;
  alter table private.provider_dispatch_envelope_reviews disable trigger guard_provider_dispatch_envelope_review_mutation;
  delete from private.provider_dispatch_envelope_reviews where envelope_id = 'fictiv-s11b-race-envelope';
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
  where provider = 'fictiv' and policy_revision = 'fictiv-s11b-race.v1';
  alter table private.quote_provider_admission_policies enable trigger capture_quote_provider_admission_policy_history;
  alter table private.quote_provider_admission_policies enable trigger guard_quote_provider_admission_policy_mutation;
  alter table private.quote_provider_admission_policy_history disable trigger reject_quote_provider_admission_history_mutation;
  delete from private.quote_provider_admission_policy_history
  where provider = 'fictiv' and policy_revision = 'fictiv-s11b-race.v1';
  alter table private.quote_provider_admission_policy_history enable trigger reject_quote_provider_admission_history_mutation;

  delete from private.quote_run_rollup_followups where job_id in (select id from public.jobs where organization_id=v_org);
  alter table private.vendor_quote_acceptance_receipts disable trigger vendor_quote_acceptance_receipts_append_only;
  delete from private.vendor_quote_acceptance_receipts where job_id in (select id from public.jobs where organization_id=v_org);
  alter table private.vendor_quote_acceptance_receipts enable trigger vendor_quote_acceptance_receipts_append_only;
  -- Export receipts intentionally have no deletion coupling; remove only
  -- this fixture's evidence explicitly before deleting its canonical rows.
  alter table private.job_export_declarations disable trigger job_export_declarations_append_only;
  delete from private.job_export_declarations where organization_id=v_org;
  alter table private.job_export_declarations enable trigger job_export_declarations_append_only;
  alter table private.job_file_export_scans disable trigger job_file_export_scans_append_only;
  delete from private.job_file_export_scans where organization_id=v_org;
  alter table private.job_file_export_scans enable trigger job_file_export_scans_append_only;
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
  delete from auth.users where id = '00000000-0000-4000-8000-0000001199e1'; -- NOSONAR: deterministic cleanup fixture ID intentionally repeats setup ID
  update private.commercial_rollout_controls
  set enabled = false, revision = 0,
      change_reason = 'Default-off automatic quote rollout',
      updated_by_user_id = null, updated_by_actor = null
  where capability = 'automatic_quote_collection';
end;
$$;

do $$
begin
  if 's11b_a' = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
    perform extensions.dblink_disconnect('s11b_a');
  end if;
  if 's11b_b' = any(coalesce(extensions.dblink_get_connections(), array[]::text[])) then
    perform extensions.dblink_disconnect('s11b_b');
  end if;
end;
$$;


select no_plan();

begin;

insert into auth.users (id, aud, role, email, email_confirmed_at)
values ('00000000-0000-4000-8000-0000001199e1', 'authenticated', 'authenticated',
  's11b-concurrency@example.test', timezone('utc', now()));
insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-0000001199e2', 'OVD 459 Concurrency', 'ovd-459-concurrency');
insert into public.organization_memberships (organization_id, user_id, role)
values ('00000000-0000-4000-8000-0000001199e2', '00000000-0000-4000-8000-0000001199e1', 'client');
update public.organizations set shipping_same_as_billing = false, shipping_street = '123 Fixture Ave',
  shipping_city = 'Tucson', shipping_state = 'AZ', shipping_zip = '85701', shipping_country = 'US'
where id = '00000000-0000-4000-8000-0000001199e2';
insert into private.sourcing_destination_history (organization_id, state, address)
values ('00000000-0000-4000-8000-0000001199e2', 'confirmed',
  private.effective_sourcing_address('00000000-0000-4000-8000-0000001199e2'));
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason, granted_by_user_id
) values ('00000000-0000-4000-8000-0000001199e2', 'complimentary', now() - interval '1 day',
  now() + interval '30 days', 'S1.1b concurrency fixture', '00000000-0000-4000-8000-0000001199e1');
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
) values ('00000000-0000-4000-8000-0000001199e2', '00000000-0000-4000-8000-0000001199e1', 'grant',
  'S1.1b concurrency fixture', 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy',
  's11b-concurrency-grant');
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
values ('00000000-0000-4000-8000-0000001199e2', '00000000-0000-4000-8000-0000001199e1',
  'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy');
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
values ('00000000-0000-4000-8000-0000001199e2', 'fictiv', true);
update private.commercial_rollout_controls
set enabled = true, revision = revision + 1, change_reason = 'S1.1b concurrency fixture'
where capability = 'automatic_quote_collection';
update private.quote_provider_admission_policies
set admission_state = 'approved', generic_dispatch_enabled = true,
  policy_revision = 'fictiv-s11b-race.v1', evidence_reference = 'OVD-458',
  permission_basis = 'written_provider_authorization',
  supported_processes = array['cnc_milling']::public.process_types[],
  accepted_file_extensions = array['step', 'stp'], session_owner = 'overdrafter_managed',
  reviewed_by = '00000000-0000-4000-8000-0000001199e1', reviewed_at = now() - interval '1 day',
  expires_at = null, change_reason = 'approval_recorded'
where provider = 'fictiv';
-- Replace the OVD-673 migration envelope with this file's synthetic review.
update private.provider_dispatch_envelope_reviews set withdrawn_at = now()
where provider = 'fictiv' and withdrawn_at is null;
insert into private.provider_dispatch_envelope_reviews (provider, envelope_id, envelope_version, evidence_reference, permit_ttl_seconds)
values ('fictiv', 'fictiv-s11b-race-envelope', 1, 'OVD-459', 900);

do $$
declare
  v_index integer;
  v_job uuid;
begin
  for v_index in 1..5 loop
    v_job := ('00000000-0000-4000-8000-0000001199a' || v_index::text)::uuid;
    insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
    values (v_job, '00000000-0000-4000-8000-0000001199e2', '00000000-0000-4000-8000-0000001199e1',
      'Concurrent preflight part ' || v_index::text, 'ready_to_quote', array['manufacturing_quote'], 'manufacturing_quote');
    insert into public.organization_file_blobs (
      id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
    ) values (('00000000-0000-4000-8000-0000001199b' || v_index::text)::uuid, '00000000-0000-4000-8000-0000001199e2',
      repeat(v_index::text, 64), repeat(v_index::text, 64), 'job-files',
      's11b-concurrency/' || v_index::text || '.step', 100, 'application/step');
    insert into public.job_files (
      id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
      storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
    ) values (('00000000-0000-4000-8000-0000001199c' || v_index::text)::uuid, v_job,
      '00000000-0000-4000-8000-0000001199e2', '00000000-0000-4000-8000-0000001199e1',
      ('00000000-0000-4000-8000-0000001199b' || v_index::text)::uuid, repeat(v_index::text, 64),
      repeat(v_index::text, 64), 'job-files', 's11b-concurrency/' || v_index::text || '.step',
      'part-' || v_index::text || '.step', 'part-' || v_index::text, 'cad', 'application/step', 100);
    insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, quantity)
    values (('00000000-0000-4000-8000-0000001199d' || v_index::text)::uuid, v_job,
      '00000000-0000-4000-8000-0000001199e2', 'Part ' || v_index::text, 'part-' || v_index::text,
      ('00000000-0000-4000-8000-0000001199c' || v_index::text)::uuid, 1);
    insert into public.approved_part_requirements (
      part_id, organization_id, approved_by, material, finish, tightest_tolerance_inch, quantity,
      quote_quantities, applicable_vendors, spec_snapshot
    ) values (('00000000-0000-4000-8000-0000001199d' || v_index::text)::uuid, '00000000-0000-4000-8000-0000001199e2',
      '00000000-0000-4000-8000-0000001199e1', '6061-T6 Aluminum', 'As machined', 0.005, 1, array[1],
      array['fictiv']::public.vendor_name[], '{"process":"CNC milling"}'::jsonb);
  end loop;
end;
$$;

-- Runs the preflight exactly as the worker would: service_role, the claimed
-- task, its result, and the lane's staged scope.
create or replace function public.s11b_preflight_attempt(p_permit_id uuid)
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
    v_task_id, v_result_id, v_snapshot, 's11b-race-worker', v_claimed_at
  );
  perform pg_catalog.set_config('role', 'none', true);
  return v_decision;
exception when others then
  return pg_catalog.jsonb_build_object('error', sqlerrm);
end;
$$;

-- Cancels the permit's quote request as the job's client, the way the app
-- does. With a hold key, the cancellation then stays uncommitted until the
-- driver releases that key.
create or replace function public.s11b_cancel_attempt(p_permit_id uuid, p_hold_key text)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_request_id uuid;
  v_cancellation jsonb;
begin
  select permit.quote_request_id into strict v_request_id
  from private.provider_dispatch_permits permit
  where permit.id = p_permit_id;
  perform pg_catalog.set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000001199e1","role":"authenticated","aal":"aal1"}', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000001199e1', true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
  perform pg_catalog.set_config('role', 'authenticated', true);
  v_cancellation := public.api_cancel_quote_request(v_request_id);
  perform pg_catalog.set_config('role', 'none', true);
  if p_hold_key is not null then
    perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(p_hold_key, 0));
  end if;
  return v_cancellation;
exception when others then
  return pg_catalog.jsonb_build_object('error', sqlerrm);
end;
$$;


commit;

select pg_catalog.set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000001199e1","role":"authenticated","aal":"aal1"}', false);
select pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000001199e1', false);
select pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);

-- Mint and claim one permit per race.
create temporary table s11b_permits (race text primary key, permit_id uuid not null);
begin;
insert into s11b_permits
select race, (public.api_request_provider_dispatch(
  job_id, 'fictiv', 'inch',
  public.api_get_provider_dispatch_scope(job_id, 'fictiv', 'inch') ->> 'scopeFingerprint',
  'founding-beta-2026-08-15', 'fictiv-s11b-race-envelope.v1', approval_reference, true, true, true
) ->> 'permitId')::uuid
from (values
  ('revocation_first', '00000000-0000-4000-8000-0000001199a1'::uuid, '00000000-0000-4000-8000-0000001199f1'::uuid),
  ('preflight_first', '00000000-0000-4000-8000-0000001199a2'::uuid, '00000000-0000-4000-8000-0000001199f2'::uuid),
  ('cancellation_first', '00000000-0000-4000-8000-0000001199a3'::uuid, '00000000-0000-4000-8000-0000001199f3'::uuid),
  ('preflight_before_cancellation', '00000000-0000-4000-8000-0000001199a4'::uuid, '00000000-0000-4000-8000-0000001199f4'::uuid),
  ('expiry_during_wait', '00000000-0000-4000-8000-0000001199a5'::uuid, '00000000-0000-4000-8000-0000001199f5'::uuid)
) races(race, job_id, approval_reference);
update public.work_queue
set status = 'running', locked_at = date_trunc('milliseconds', now()), locked_by = 's11b-race-worker' -- NOSONAR: deterministic worker-claim fixture
where id in (select work_queue_task_id from private.provider_dispatch_permits
  where id in (select permit_id from s11b_permits));
update public.vendor_quote_results set status = 'running'
where id in (select vendor_quote_result_id from private.provider_dispatch_permits
  where id in (select permit_id from s11b_permits));
-- OVD-723 (window 1): once the export-control dispatch gate exists, an
-- authorized dispatch also needs the job's clean declaration and, for every
-- part file, a worker-verified hash and a clean scan of those bytes. Seed that
-- state for this suite's fixtures. Without the gate this block does nothing.
do $ovd723$
begin
  if pg_catalog.to_regclass('private.job_export_declarations') is null then
    return;
  end if;
  insert into private.job_export_declarations (job_id, organization_id, declared_by, answer, terms_version)
  select job.id, job.organization_id, job.created_by, 'not_controlled', 'ovd-beta-export-control.v1'
  from public.jobs job
  where job.id in (select task.job_id from public.work_queue task)
    and job.created_by is not null;
  update public.job_files file
  set trusted_content_sha256 = pg_catalog.lower(file.content_sha256)
  where file.job_id in (select task.job_id from public.work_queue task)
    and file.trusted_content_sha256 is null
    and file.content_sha256 ~ '^[0-9a-f]{64}$';
  insert into private.job_file_export_scans (job_file_id, job_id, organization_id, source, content_sha256)
  select file.id, file.job_id, file.organization_id, source.name, pg_catalog.lower(file.content_sha256)
  from public.job_files file
  cross join (values ('drawing_text'), ('step_header')) as source(name)
  where file.job_id in (select task.job_id from public.work_queue task)
    and file.content_sha256 ~ '^[0-9a-f]{64}$';
end;
$ovd723$;

commit;

select pg_catalog.set_config('request.jwt.claims', '', false);
select pg_catalog.set_config('request.jwt.claim.sub', '', false);
select pg_catalog.set_config('request.jwt.claim.role', '', false);

select is(
  (select pg_catalog.count(*) from s11b_permits permits
    where public.s11b_preflight_attempt(permits.permit_id) -> 'authorized' = 'true'::jsonb),
  5::bigint,
  'every claimed race permit authorizes before any revocation, cancellation, or expiry'
);

-- Waits until exactly p_count other sessions running an s11b attempt are
-- blocked on a lock; sequential completion can then not masquerade as a race.

-- Free-beta cleanup races use the maintained admission fixture, committed here
-- so both sessions see real permits, request, task and metering receipt.
begin;
\set meter_fixture_limit 100
\ir fixtures/free_quote_meter_setup.inc
create table free_meter_fixture.s11b_cases(name text primary key, request_id uuid);
insert into free_meter_fixture.s11b_cases values ('cleanup',free_meter_fixture.new_request()),
 ('accept_first',free_meter_fixture.new_request()),('xometry_inverse',free_meter_fixture.new_request());
update public.work_queue set status='running', locked_by='s11b-race-worker',
 locked_at=date_trunc('milliseconds',now()),attempts=1
 where id in (select work_queue_task_id from private.xometry_beta_dispatch_permits
 where quote_request_id in(select request_id from free_meter_fixture.s11b_cases));
update public.vendor_quote_results set status='running' where id in
 (select vendor_quote_result_id from private.xometry_beta_dispatch_permits
 where quote_request_id in(select request_id from free_meter_fixture.s11b_cases));
commit;

-- Store the exact original RPC argument text; replay must not read cleared claim fields.
create temporary table s11b_calls as
select t.id task_id, p.vendor_quote_result_id result_id, t.job_id, t.quote_run_id,
 format('select public.accept_vendor_quote_result(%L,%L,%L,%s,%L,%L,%L,%L)',
 t.id,t.locked_by,t.locked_at,t.attempts,p.vendor_quote_result_id,
 free_meter_fixture.result_payload(),jsonb_build_array(jsonb_build_object(
 'vendor_quote_result_id',p.vendor_quote_result_id,'organization_id',t.organization_id,
 'offer_key','race','supplier','Fixture','lane_label','Race','geographic_origin','unknown',
 'sort_rank',0,'provenance_status','unverified','raw_payload','{}'::jsonb,'unit_price_usd',12)),'{}'::jsonb) sql,
 p.id permit_id, p.quote_request_id request_id
from (select id,work_queue_task_id,vendor_quote_result_id,quote_request_id from private.provider_dispatch_permits
 where organization_id='00000000-0000-4000-8000-0000001199e2'
 union all select id,work_queue_task_id,vendor_quote_result_id,quote_request_id from private.xometry_beta_dispatch_permits
 where quote_request_id in(select request_id from free_meter_fixture.s11b_cases)) p
join public.work_queue t on t.id=p.work_queue_task_id;

create temporary table s11b_xometry_calls as select c.task_id,
 format('select public.api_authorize_xometry_beta_worker_dispatch(%L,%L,%L,%L,%L)',
 c.task_id,c.result_id,lane.scope_snapshot,t.locked_by,t.locked_at) sql
 from s11b_calls c join private.xometry_beta_dispatch_permits p on p.id=c.permit_id
 join public.quote_request_lanes lane on lane.id=p.quote_request_lane_id
 join public.work_queue t on t.id=c.task_id;
create function public.s11b_hold(p_sql text) returns jsonb language plpgsql as $$
declare response jsonb; begin
 execute p_sql into response;
 perform pg_advisory_xact_lock_shared(119911);
 return coalesce(response,'{}'::jsonb);
end $$;

create function pg_temp.s11b_wait(p_application text, p_event text default 'Lock') returns boolean language plpgsql as $$
begin
 for attempt in 1..250 loop
  perform pg_stat_clear_snapshot();
  if exists(select 1 from pg_stat_activity where application_name=p_application
   and wait_event_type=p_event) then return true; end if;
  perform pg_sleep(0.01);
 end loop;
 return false;
end $$;

select extensions.dblink_connect('s11b_a',coalesce(nullif(current_setting('ovd.test_conninfo',true),''),'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres')||' application_name=s11b_holder');
select extensions.dblink_connect('s11b_b',coalesce(nullif(current_setting('ovd.test_conninfo',true),''),'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres')||' application_name=s11b_acceptor');
select extensions.dblink_exec('s11b_b', $$set statement_timeout='1500ms'$$);

-- Every holder actually reaches its gate with its transaction and row locks
-- still live. Busy is checked in a still-open second transaction, so absence
-- of candidate locks cannot be explained by autocommit releasing them.
create function pg_temp.s11b_busy(p_hold text, p_call text) returns jsonb language plpgsql as $$
declare b jsonb; held boolean; released boolean; pid_b integer;
begin
 perform pg_advisory_lock(119911);
 perform extensions.dblink_exec('s11b_a','begin');
 perform extensions.dblink_send_query('s11b_a',format('select public.s11b_hold(%L)',p_hold));
 held:=pg_temp.s11b_wait('s11b_holder');
 if not held then raise exception 'holder never reached lock gate'; end if;
 perform extensions.dblink_exec('s11b_b','begin');
 select x into b from extensions.dblink('s11b_b',p_call) as response(x jsonb);
 select x into pid_b from extensions.dblink('s11b_b','select pg_backend_pid()') as response(x integer);
 select not exists(select 1 from pg_locks where pid=pid_b and
 (locktype='tuple' or mode in ('RowShareLock','RowExclusiveLock','ShareRowExclusiveLock')))
 into released;
 perform extensions.dblink_exec('s11b_b','rollback');
 perform pg_advisory_unlock(119911);
 perform * from extensions.dblink_get_result('s11b_a') as response(x jsonb);
 perform * from extensions.dblink_get_result('s11b_a') as response(x jsonb);
 perform extensions.dblink_exec('s11b_a','rollback');
 return jsonb_build_object('held',held,'outcome',b->>'outcome','result',b,'released',released);
exception when others then
 perform pg_advisory_unlock(119911);
 raise;
end $$;
create temporary table s11b_races(name text, response jsonb);
insert into s11b_races select 'xometry preflight',pg_temp.s11b_busy(x.sql,c.sql)
 from s11b_calls c join s11b_xometry_calls x using(task_id)
 where c.request_id=(select request_id from free_meter_fixture.s11b_cases where name='cleanup');
insert into s11b_races
select 'preflight',pg_temp.s11b_busy(format('select public.s11b_preflight_attempt(%L)',permit_id),sql)
from s11b_calls where job_id='00000000-0000-4000-8000-0000001199a1';
-- Seed an existing offer so an offer-row holder must produce busy before upsert.
insert into public.vendor_quote_offers(vendor_quote_result_id,organization_id,offer_key,supplier,lane_label,geographic_origin)
 select result_id,t.organization_id,'race','Fixture','Race','unknown'
 from s11b_calls c join public.work_queue t on t.id=c.task_id
 where c.job_id in ('00000000-0000-4000-8000-0000001199a1','00000000-0000-4000-8000-0000001199a2');
insert into s11b_races select 'offer',pg_temp.s11b_busy(format(
 'select to_jsonb(o) from public.vendor_quote_offers o where vendor_quote_result_id=%L for update',result_id),sql)
 from s11b_calls where job_id='00000000-0000-4000-8000-0000001199a1';
-- Uncommitted DML elsewhere on hot tables must not serialize acceptance.
create temporary table s11b_unrelated as
 select 'job' name,pg_temp.s11b_busy(
 'update public.jobs set title=title where id=''00000000-0000-4000-8000-0000001199a2'' returning to_jsonb(jobs)',sql) response
 from s11b_calls where job_id='00000000-0000-4000-8000-0000001199a1';
insert into s11b_unrelated
 select 'offer',pg_temp.s11b_busy(format(
 'update public.vendor_quote_offers set notes=notes where vendor_quote_result_id=%L returning to_jsonb(vendor_quote_offers)',a.result_id),b.sql)
 from s11b_calls a cross join s11b_calls b
 where a.job_id='00000000-0000-4000-8000-0000001199a1'
 and b.job_id='00000000-0000-4000-8000-0000001199a2';
select is(response->>'outcome','accepted','unrelated '||name||' write does not block acceptance') from s11b_unrelated;

insert into s11b_races select 'task',pg_temp.s11b_busy(format('select to_jsonb(t) from public.work_queue t where id=%L for update', task_id),sql) from s11b_calls where job_id='00000000-0000-4000-8000-0000001199a1';
insert into s11b_races select 'permit',pg_temp.s11b_busy(format('select to_jsonb(t) from private.provider_dispatch_permits t where id=%L for update', permit_id),sql) from s11b_calls where job_id='00000000-0000-4000-8000-0000001199a1';
insert into s11b_races select 'result',pg_temp.s11b_busy(format('select to_jsonb(t) from public.vendor_quote_results t where id=%L for update', result_id),sql) from s11b_calls where job_id='00000000-0000-4000-8000-0000001199a1';
insert into s11b_races select 'request',pg_temp.s11b_busy(format('select to_jsonb(t) from public.quote_requests t where id=%L for update', request_id),sql) from s11b_calls where job_id='00000000-0000-4000-8000-0000001199a1';
insert into s11b_races select 'cancel',pg_temp.s11b_busy(
 format('select public.s11b_cancel_attempt(%L,null)',permit_id),sql)
 from s11b_calls where job_id='00000000-0000-4000-8000-0000001199a2';
-- The sweep only discovers QUEUED tasks. Its transaction temporarily requeues
-- this running fixture and its lane; rollback restores the exact original claim.
update private.provider_kill_switches set engaged=true where provider='fictiv';
insert into s11b_races select 'kill sweep',pg_temp.s11b_busy(format(
 'update public.work_queue set status=''queued'',payload=payload||jsonb_build_object(''vendor'',''fictiv'',''vendorQuoteResultId'',%L) where id=%L; update public.vendor_quote_results set status=''queued'' where id=%L; select public.api_worker_cancel_provider_disabled_tasks()',result_id,task_id,result_id),sql)
 from s11b_calls where job_id='00000000-0000-4000-8000-0000001199a3';
update private.provider_kill_switches set engaged=false where provider='fictiv';
insert into s11b_races select 'stale cleanup',pg_temp.s11b_busy(format(
 'update public.work_queue set status=''failed'',locked_by=null,locked_at=null where id=%L; select public.api_reconcile_terminal_free_quote_tasks()',task_id),sql)
 from s11b_calls where request_id=(select request_id from free_meter_fixture.s11b_cases where name='cleanup');
select is(response->>'held','true',name||' holder confirmed by pg_stat_activity') from s11b_races;
select is(response->>'outcome','busy',name||' accept returns busy before timeout') from s11b_races;
select is(response->>'released','true',name||' busy releases all candidate locks') from s11b_races;

-- Actual retry + lost-ack replay once holders rolled back.
create temporary table s11b_retry as select task_id,sql,null::jsonb response,null::jsonb replay from s11b_calls
 where job_id in ('00000000-0000-4000-8000-0000001199a1','00000000-0000-4000-8000-0000001199a2','00000000-0000-4000-8000-0000001199a3')
 or request_id=(select request_id from free_meter_fixture.s11b_cases where name='cleanup');
create function pg_temp.s11b_execute(p_sql text) returns jsonb language plpgsql as $$ declare r jsonb; begin execute p_sql into r; return r; end $$;
update s11b_retry set response=pg_temp.s11b_execute(sql);
update s11b_retry set replay=pg_temp.s11b_execute(sql);
select is(response->>'outcome','accepted','retry after release succeeds') from s11b_retry;
select is(replay->>'outcome','replayed','retry succeeds exactly once') from s11b_retry;
select is(count(*)::int,1,'no duplicate offer') from public.vendor_quote_offers
 where vendor_quote_result_id in(select result_id from s11b_calls where task_id in(select task_id from s11b_retry)) group by vendor_quote_result_id;

-- Accept-first order: real cancellation/preflight wait, then observe committed
-- terminal state after release. Sweep and cleanup must SKIP the held task/result.
create function pg_temp.s11b_accept_first(p_call text,p_second text,p_wait boolean)
returns jsonb language plpgsql as $$ declare a jsonb; b jsonb; observed boolean; begin
 perform extensions.dblink_exec('s11b_a','begin');
 select x into a from extensions.dblink('s11b_a',p_call) as response(x jsonb);
 perform extensions.dblink_send_query('s11b_b',p_second);
 if p_wait then
  observed:=pg_temp.s11b_wait('s11b_acceptor');
 else
  -- Nonblocking sweep/cleanup is required to finish while acceptance holds locks.
  for attempt in 1..100 loop
   exit when extensions.dblink_is_busy('s11b_b')=0;
   perform pg_sleep(0.01);
  end loop;
  observed:=extensions.dblink_is_busy('s11b_b')=0;
 end if;
 perform extensions.dblink_exec('s11b_a','commit');
 select x into b from extensions.dblink_get_result('s11b_b') as response(x jsonb);
 perform * from extensions.dblink_get_result('s11b_b') as response(x jsonb);
 return jsonb_build_object('accepted',a->>'outcome','observed',observed,'second',b);
end $$;
insert into s11b_races select 'accept then preflight',pg_temp.s11b_accept_first(sql,
 format('select public.s11b_preflight_attempt(%L)',permit_id),true)
 from s11b_calls where job_id='00000000-0000-4000-8000-0000001199a4';
-- Re-use the accepted call for cancel: replay is lock-free, so make a separate
-- new acceptance on the fifth generic fixture for the inverse cancellation.
insert into s11b_races select 'accept then cancel',pg_temp.s11b_accept_first(sql,
 format('select public.s11b_cancel_attempt(%L,null)',permit_id),true)
 from s11b_calls where job_id='00000000-0000-4000-8000-0000001199a5';
insert into s11b_races select 'accept then cleanup',pg_temp.s11b_accept_first(sql,
 'select jsonb_build_object(''cleanup'',public.api_reconcile_terminal_free_quote_tasks(),''sweep'',public.api_worker_cancel_provider_disabled_tasks())',false)
 from s11b_calls where request_id=(select request_id from free_meter_fixture.s11b_cases where name='accept_first');
insert into s11b_races select 'accept then xometry',pg_temp.s11b_accept_first(c.sql,x.sql,true)
 from s11b_calls c join s11b_xometry_calls x using(task_id)
 where c.request_id=(select request_id from free_meter_fixture.s11b_cases where name='xometry_inverse');
select is(response->'second'->>'reasonCode','dispatch_task_not_running','xometry observes completed generation')
 from s11b_races where name='accept then xometry';
select is(response->>'accepted','accepted',name||' commits once') from s11b_races where name like 'accept then%';
select is(response->>'observed','true',name||' inverse order observed') from s11b_races where name like 'accept then%';
select is(response->'second'->>'denial','task_inactive','preflight observes completed claim') from s11b_races where name='accept then preflight';
select is(response->'second'->'sweep'->>'cancelled','0','accept-first sweep has no eligible task') from s11b_races where name='accept then cleanup';
select is(response->'second'->>'reasonCode','already_received','cancel observes accepted quote') from s11b_races where name='accept then cancel';

-- Drain must defer and release its candidate on either job or run contention.
select is(public.drain_quote_run_rollup_followups()->>'processed','8','all independent followups drain');
update private.quote_run_rollup_followups set processed_at=null where quote_run_id=(select quote_run_id from s11b_calls limit 1);
insert into s11b_races select 'drain job',pg_temp.s11b_busy(format('select to_jsonb(j) from public.jobs j where id=%L for update',job_id),
 'select public.drain_quote_run_rollup_followups()') from s11b_calls limit 1;
insert into s11b_races select 'drain run',pg_temp.s11b_busy(format('select to_jsonb(r) from public.quote_runs r where id=%L for update',quote_run_id),
 'select public.drain_quote_run_rollup_followups()') from s11b_calls limit 1;
-- Generic busy harness retains drain counters in outcome below (patched helper).
select is(response->>'released','true',name||' releases candidate locks') from s11b_races where name like 'drain %';
select is(response->'result'->>'deferred','1',name||' deferred once') from s11b_races where name like 'drain %';
select is(public.drain_quote_run_rollup_followups()->>'processed','1','drain retry processes pending row');
select is(public.drain_quote_run_rollup_followups()->>'processed','0','drain repeat idempotent');
select extensions.dblink_disconnect('s11b_a');
select extensions.dblink_disconnect('s11b_b');

-- Full cleanup, including immutable evidence owned exclusively by these fixtures.
begin;
select public.s11b_cleanup_concurrency_fixture();
alter table private.quote_access_admissions disable trigger quote_access_admission_immutable;
delete from private.quote_access_admissions where organization_id='00000000-0000-4000-8000-000000008812';
alter table private.quote_access_admissions enable trigger quote_access_admission_immutable;
alter table private.xometry_beta_dispatch_permits disable trigger xometry_beta_dispatch_permits_append_only;
delete from private.xometry_beta_dispatch_permits where organization_id='00000000-0000-4000-8000-000000008812';
alter table private.xometry_beta_dispatch_permits enable trigger xometry_beta_dispatch_permits_append_only;
delete from private.quote_run_rollup_followups where job_id in(select id from public.jobs where organization_id='00000000-0000-4000-8000-000000008812');
alter table private.vendor_quote_acceptance_receipts disable trigger vendor_quote_acceptance_receipts_append_only;
delete from private.vendor_quote_acceptance_receipts where job_id in(select id from public.jobs where organization_id='00000000-0000-4000-8000-000000008812');
alter table private.vendor_quote_acceptance_receipts enable trigger vendor_quote_acceptance_receipts_append_only;
alter table private.founding_beta_enrollment_events disable trigger founding_beta_enrollment_events_append_only;
delete from private.founding_beta_enrollment_events where organization_id='00000000-0000-4000-8000-000000008812';
alter table private.founding_beta_enrollment_events enable trigger founding_beta_enrollment_events_append_only;
alter table private.founding_beta_notice_acceptances disable trigger founding_beta_notice_acceptances_append_only;
delete from private.founding_beta_notice_acceptances where organization_id='00000000-0000-4000-8000-000000008812';
alter table private.founding_beta_notice_acceptances enable trigger founding_beta_notice_acceptances_append_only;
delete from public.organizations where id='00000000-0000-4000-8000-000000008812';
delete from auth.users where id='00000000-0000-4000-8000-000000008811';
alter table private.free_quote_buckets disable trigger free_quote_bucket_immutable;
delete from private.free_quote_buckets where subject_id='00000000-0000-4000-8000-000000008812';
alter table private.free_quote_buckets enable trigger free_quote_bucket_immutable;
alter table private.free_quote_policies disable trigger free_quote_policy_immutable;
delete from private.free_quote_policies where revision='synthetic-meter-only';
alter table private.free_quote_policies enable trigger free_quote_policy_immutable;
-- Restore exact global configuration snapshots rather than assuming defaults.
do $$ declare target text; snapshot text; key text; cols text; begin
 for target,snapshot,key in select * from (values
 ('private.quote_provider_admission_policies','s11b_policy_before','provider'),
 ('private.commercial_rollout_controls','s11b_control_before','capability')) x(t,s,k) loop
  select string_agg(quote_ident(attname),',' order by attnum) into cols from pg_attribute
    where attrelid=target::regclass and attnum>0 and not attisdropped and attname<>key;
  execute format('alter table %s disable trigger user',target);
  execute format('update %s t set (%s)=(select %s from jsonb_populate_record(null::%s,b.row) r) from %I b where t.%I=(jsonb_populate_record(null::%s,b.row)).%I',
    target,cols,cols,target,snapshot,key,target,key);
  execute format('alter table %s enable trigger user',target);
 end loop;
end $$;
alter table private.provider_dispatch_envelope_reviews disable trigger user;
update private.provider_dispatch_envelope_reviews p set withdrawn_at=b.withdrawn_at from s11b_envelope_before b where p.id=b.id;
alter table private.provider_dispatch_envelope_reviews enable trigger user;
update private.provider_kill_switches s set (engaged,reason,engaged_by,engaged_at,version)=(b.engaged,b.reason,b.engaged_by,b.engaged_at,b.version)
from s11b_switch_before b where s.provider=b.provider;
drop schema free_meter_fixture cascade;
drop function public.s11b_hold(text),public.s11b_preflight_attempt(uuid),
 public.s11b_cancel_attempt(uuid,text),public.s11b_cleanup_concurrency_fixture();
commit;
select is((select count(*)::int from public.organizations where id in
 ('00000000-0000-4000-8000-0000001199e2','00000000-0000-4000-8000-000000008812')),0,'full fixture cleanup');
select is((select to_jsonb(p) from private.quote_provider_admission_policies p where provider='fictiv'),
 (select row from s11b_policy_before),'policy snapshot fully restored');
select ok(not exists(select 1 from private.commercial_rollout_controls p join s11b_control_before b
 on p.capability=b.row->>'capability' where to_jsonb(p) is distinct from b.row),'rollout snapshot fully restored');
create function pg_temp.s11b_remaining_fixture_rows() returns table(relation_name text,rows_left bigint)
 language plpgsql as $$ declare t record; n bigint; begin
 for t in select table_schema,table_name from information_schema.columns
  where column_name='organization_id' and table_schema in ('public','private') loop
  execute format('select count(*) from %I.%I where organization_id in (%L,%L)',
   t.table_schema,t.table_name,'00000000-0000-4000-8000-0000001199e2','00000000-0000-4000-8000-000000008812') into n;
  if n>0 then relation_name:=t.table_schema||'.'||t.table_name;rows_left:=n;return next;end if;
 end loop;
end $$;
select is_empty('select * from pg_temp.s11b_remaining_fixture_rows()','all org-scoped fixture records cleaned, including immutable export receipts');
select is((select count(*)::int from private.vendor_quote_acceptance_receipts r join s11b_calls c on c.task_id=r.work_queue_task_id),0,'all acceptance receipts cleaned');
select is((select count(*)::int from private.quote_run_rollup_followups f join s11b_calls c on c.quote_run_id=f.quote_run_id),0,'all followups cleaned');
select * from finish();
