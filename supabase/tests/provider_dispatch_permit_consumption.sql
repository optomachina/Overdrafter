-- OVD-734 durable provider dispatch permit consumption.
-- Synthetic identifiers only. One generic fictiv permit is minted through the
-- real OVD-458 RPC and its task is claimed the way the worker claims it; each
-- scenario starts from that unconsumed permit and is rolled back to it.
begin;

select plan(44);

-- OVD-734 is a proposed migration that is intentionally NOT in supabase/migrations
-- yet (needs a migration window). fixtures/ holds a byte copy of
-- docs/migration-drafts/ovd-734.sql, kept identical by
-- scripts/run-supabase-policy-tests.node-test.mjs, and it is installed inside this
-- rolled-back transaction only when the table is absent. Once the migration is
-- promoted, the guard is false and every assertion runs against the real schema.
select pg_catalog.to_regclass('private.provider_dispatch_permit_consumptions') is null as ovd734_install_draft \gset
\if :ovd734_install_draft
\ir fixtures/ovd734_provider_dispatch_permit_consumption.inc
\endif

-- TEST STUB ONLY, rolled back with this transaction: OVD-722
-- (docs/migration-drafts/ovd-722.sql, PR #676) is not on main, so its two kill
-- switch tables are absent. This creates the subset of their columns the draft
-- reads, under the exact OVD-722 names, only when they are missing. Once OVD-722
-- is applied the real tables and their seed rows are used instead.
create table if not exists private.provider_kill_switches (
  provider public.vendor_name primary key,
  engaged boolean not null default false
);
create table if not exists private.provider_global_kill_switch (
  singleton boolean primary key default true check (singleton),
  engaged boolean not null default false
);
insert into private.provider_kill_switches (provider, engaged)
select provider, false from pg_catalog.unnest(pg_catalog.enum_range(null::public.vendor_name)) as provider
on conflict (provider) do nothing;
insert into private.provider_global_kill_switch (singleton, engaged) values (true, false)
on conflict (singleton) do nothing;

create function pg_temp.as_user(p_user_id uuid)
returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', p_user_id, 'role', 'authenticated', 'aal', 'aal1')::text,
    true
  );
  perform pg_catalog.set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform pg_catalog.set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

create function pg_temp.denied(p_denial text)
returns jsonb
language sql
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object(
    'schema', 'provider-dispatch-permit-consumption.v1', 'consumed', false, 'denial', p_denial);
$$;

-- Catalog and grant boundaries.
select has_table('private', 'provider_dispatch_permit_consumptions', 'the consumption table exists');
select ok(
  (select i.indisprimary and pg_catalog.pg_get_indexdef(i.indexrelid) like '%(permit_id, attempt)'
   from pg_catalog.pg_index i
   where i.indrelid = 'private.provider_dispatch_permit_consumptions'::regclass and i.indisprimary),
  'the primary key is (permit_id, attempt)'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_catalog.pg_class
    where oid = 'private.provider_dispatch_permit_consumptions'::regclass)
  and not exists (select 1 from pg_catalog.pg_policies
    where schemaname = 'private' and tablename = 'provider_dispatch_permit_consumptions'),
  'RLS is enabled and forced with no policies'
);
select ok(
  not exists (
    select 1
    from (values ('public'), ('anon'), ('authenticated'), ('service_role')) as r(role),
      (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(privilege)
    where pg_catalog.has_table_privilege(r.role, 'private.provider_dispatch_permit_consumptions', p.privilege)
  ),
  'no API role holds any privilege on the consumption table'
);

create temporary table ovd734_rpcs (signature regprocedure not null) on commit drop;
insert into ovd734_rpcs values
  ('public.api_consume_provider_dispatch_permit(uuid, uuid, uuid, text, text)'),
  ('public.api_mark_provider_dispatch_permit_side_effect_started(uuid, integer, text)'),
  ('public.api_record_provider_dispatch_permit_outcome(uuid, integer, text, text)');

select is(
  (select pg_catalog.count(*) from ovd734_rpcs rpc join pg_catalog.pg_proc proc on proc.oid = rpc.signature
    where proc.prosecdef
      and 'search_path=""' = any(proc.proconfig)
      and 'lock_timeout=2s' = any(proc.proconfig)),
  3::bigint,
  'every consumption RPC is security definer with an empty search_path and a 2s lock_timeout'
);
select ok(
  (select bool_and(
      pg_catalog.has_function_privilege('service_role', rpc.signature, 'EXECUTE')
      and not pg_catalog.has_function_privilege('anon', rpc.signature, 'EXECUTE')
      and not pg_catalog.has_function_privilege('authenticated', rpc.signature, 'EXECUTE')
      and not pg_catalog.has_function_privilege('public', rpc.signature, 'EXECUTE'))
   from ovd734_rpcs rpc),
  'only service_role can execute the consumption RPCs'
);
select ok(
  not exists (
    select 1
    from (values ('public'), ('anon'), ('authenticated'), ('service_role')) as r(role),
      (values ('private.provider_dispatch_permit_consumption_denial(text)'::regprocedure),
        ('private.provider_dispatch_permit_kill_switch_engaged(public.vendor_name)'::regprocedure),
        ('private.guard_provider_dispatch_permit_consumption()'::regprocedure)) as f(signature)
    where pg_catalog.has_function_privilege(r.role, f.signature, 'EXECUTE')
  ),
  'no API role can execute the private helpers'
);

-- Synthetic generic tenant (fictiv), enabled exactly as the OVD-459 fixture.
insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-000000073401', 'authenticated', 'authenticated', 'ovd734-member@example.test', now());
insert into public.organizations (id, name, slug) values
  ('00000000-0000-4000-8000-000000073402', 'OVD 734 Consumption', 'ovd-734-consumption');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('00000000-0000-4000-8000-000000073402', '00000000-0000-4000-8000-000000073401', 'client');
update public.organizations set shipping_same_as_billing = false, shipping_street = '123 Fixture Ave',
  shipping_city = 'Tucson', shipping_state = 'AZ', shipping_zip = '85701', shipping_country = 'US'
where id = '00000000-0000-4000-8000-000000073402';
insert into private.sourcing_destination_history (organization_id, state, address)
values ('00000000-0000-4000-8000-000000073402', 'confirmed',
  private.effective_sourcing_address('00000000-0000-4000-8000-000000073402'));
insert into private.organization_entitlement_grants (
  organization_id, grant_type, starts_at, review_at, grant_reason, granted_by_user_id
) values ('00000000-0000-4000-8000-000000073402', 'complimentary', now() - interval '1 day',
  now() + interval '30 days', 'OVD-734 fixture', '00000000-0000-4000-8000-000000073401');
insert into private.founding_beta_enrollment_events (
  organization_id, actor_user_id, action, reason, policy_revision, terms_path, privacy_path, idempotency_key
) values ('00000000-0000-4000-8000-000000073402', '00000000-0000-4000-8000-000000073401', 'grant',
  'OVD-734 fixture', 'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy', 'ovd734-grant');
insert into private.founding_beta_notice_acceptances (organization_id, user_id, policy_revision, terms_path, privacy_path)
values ('00000000-0000-4000-8000-000000073402', '00000000-0000-4000-8000-000000073401',
  'founding-beta-2026-08-15', '/legal/beta-terms', '/legal/privacy');
insert into public.org_vendor_configs (organization_id, vendor, enabled_for_client_quote_requests)
values ('00000000-0000-4000-8000-000000073402', 'fictiv', true);
update private.commercial_rollout_controls
set enabled = true, revision = revision + 1, change_reason = 'OVD-734 local pgTAP fixture'
where capability = 'automatic_quote_collection';
update private.quote_provider_admission_policies
set admission_state = 'approved', generic_dispatch_enabled = true,
  policy_revision = 'fictiv-ovd734-2026-10-11.v1', evidence_reference = 'OVD-458',
  permission_basis = 'written_provider_authorization',
  supported_processes = array['cnc_milling']::public.process_types[],
  accepted_file_extensions = array['step', 'stp'], session_owner = 'overdrafter_managed',
  reviewed_by = '00000000-0000-4000-8000-000000073401', reviewed_at = now() - interval '1 day',
  expires_at = null, change_reason = 'approval_recorded'
where provider = 'fictiv';
-- The reviewed envelope is the OVD-673 migration row (fictiv-quote-envelope.v1).

insert into public.jobs (id, organization_id, created_by, title, status, requested_service_kinds, primary_service_kind)
values ('00000000-0000-4000-8000-000000073403', '00000000-0000-4000-8000-000000073402',
  '00000000-0000-4000-8000-000000073401', 'OVD-734 generic part', 'ready_to_quote',
  array['manufacturing_quote'], 'manufacturing_quote');
insert into public.organization_file_blobs (
  id, organization_id, content_sha256, trusted_content_sha256, storage_bucket, storage_path, size_bytes, mime_type
) values ('00000000-0000-4000-8000-000000073405', '00000000-0000-4000-8000-000000073402', repeat('7', 64),
  repeat('7', 64), 'job-files', 'ovd734/part.step', 100, 'application/step');
insert into public.job_files (
  id, job_id, organization_id, uploaded_by, blob_id, content_sha256, trusted_content_sha256,
  storage_bucket, storage_path, original_name, normalized_name, file_kind, mime_type, size_bytes
) values ('00000000-0000-4000-8000-000000073406', '00000000-0000-4000-8000-000000073403',
  '00000000-0000-4000-8000-000000073402', '00000000-0000-4000-8000-000000073401',
  '00000000-0000-4000-8000-000000073405', repeat('7', 64), repeat('7', 64), 'job-files',
  'ovd734/part.step', 'part.step', 'part', 'cad', 'application/step', 100);
insert into public.parts (id, job_id, organization_id, name, normalized_key, cad_file_id, quantity)
values ('00000000-0000-4000-8000-000000073404', '00000000-0000-4000-8000-000000073403',
  '00000000-0000-4000-8000-000000073402', 'Generic part', 'generic-part',
  '00000000-0000-4000-8000-000000073406', 1);
insert into public.approved_part_requirements (
  part_id, organization_id, approved_by, material, finish, tightest_tolerance_inch, quantity,
  quote_quantities, applicable_vendors, spec_snapshot
) values ('00000000-0000-4000-8000-000000073404', '00000000-0000-4000-8000-000000073402',
  '00000000-0000-4000-8000-000000073401', '6061-T6 Aluminum', 'As machined', 0.005, 1, array[1],
  array['fictiv']::public.vendor_name[], '{"process":"CNC milling"}'::jsonb);

-- Mint one generic permit through the real request RPC.
create temporary table ovd734_minted (permit_id uuid primary key) on commit drop;
grant select, insert on ovd734_minted to authenticated;
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000073401');
insert into ovd734_minted
select (public.api_request_provider_dispatch(
  '00000000-0000-4000-8000-000000073403', 'fictiv', 'inch',
  public.api_get_provider_dispatch_scope('00000000-0000-4000-8000-000000073403', 'fictiv', 'inch') ->> 'scopeFingerprint',
  'founding-beta-2026-08-15', 'fictiv-quote-envelope.v1', '00000000-0000-4000-8000-000000073409', true, true, true
) ->> 'permitId')::uuid;
reset role;

-- Claim the task the way the worker claim does.
update public.work_queue
set status = 'running', locked_at = date_trunc('milliseconds', now()), locked_by = 'ovd734-worker-a' -- NOSONAR: deterministic worker-claim fixture
where id = (select work_queue_task_id from private.provider_dispatch_permits
  where id = (select permit_id from ovd734_minted));
update public.vendor_quote_results set status = 'running'
where id = (select vendor_quote_result_id from private.provider_dispatch_permits
  where id = (select permit_id from ovd734_minted));

create temporary table ovd734_ctx on commit drop as
select permit.id as permit_id, permit.work_queue_task_id as task_id, permit.vendor_quote_result_id as result_id
from private.provider_dispatch_permits permit
where permit.id = (select permit_id from ovd734_minted);
-- Readable by the client roles so their 42501 below can only come from EXECUTE.
grant select on ovd734_ctx to anon, authenticated;

-- Calls an RPC as service_role. The fingerprint is read from the claimed task,
-- exactly as the worker reads it.
create function pg_temp.consume(p_worker text default 'ovd734-worker-a')
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_ctx record;
  v_result jsonb;
begin
  select ctx.*, task.payload ->> 'providerDispatchEnvelopeFingerprint' as fingerprint into strict v_ctx
  from ovd734_ctx ctx join public.work_queue task on task.id = ctx.task_id;
  perform pg_catalog.set_config('role', 'service_role', true);
  v_result := public.api_consume_provider_dispatch_permit(
    v_ctx.task_id, v_ctx.result_id, v_ctx.permit_id, v_ctx.fingerprint, p_worker);
  perform pg_catalog.set_config('role', 'none', true);
  return v_result;
end;
$$;

create function pg_temp.mark(p_attempt integer, p_worker text default 'ovd734-worker-a')
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_result jsonb;
begin
  perform pg_catalog.set_config('role', 'service_role', true);
  v_result := public.api_mark_provider_dispatch_permit_side_effect_started(
    (select permit_id from ovd734_ctx), p_attempt, p_worker);
  perform pg_catalog.set_config('role', 'none', true);
  return v_result;
end;
$$;

create function pg_temp.record(p_attempt integer, p_outcome text, p_worker text default 'ovd734-worker-a')
returns jsonb
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_result jsonb;
begin
  perform pg_catalog.set_config('role', 'service_role', true);
  v_result := public.api_record_provider_dispatch_permit_outcome(
    (select permit_id from ovd734_ctx), p_attempt, p_worker, p_outcome);
  perform pg_catalog.set_config('role', 'none', true);
  return v_result;
end;
$$;

create function pg_temp.granted(p_attempt integer)
returns jsonb
language sql
set search_path = pg_catalog
as $$
  select pg_catalog.jsonb_build_object('schema', 'provider-dispatch-permit-consumption.v1', 'consumed', true,
    'permitId', (select permit_id from ovd734_ctx), 'attempt', p_attempt);
$$;

create function pg_temp.requeue_to(p_worker text)
returns void
language sql
set search_path = pg_catalog
as $$
  update public.work_queue set locked_by = p_worker, locked_at = pg_catalog.clock_timestamp()
  where id = (select task_id from ovd734_ctx);
$$;

-- Client roles are denied EXECUTE outright.
set local role anon;
select throws_ok(
  $$select public.api_consume_provider_dispatch_permit((select task_id from ovd734_ctx), (select result_id from ovd734_ctx),
    (select permit_id from ovd734_ctx), repeat('a', 64), 'ovd734-worker-a')$$,
  '42501', null, 'anon cannot consume a permit');
reset role;
set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-000000073401');
select throws_ok(
  $$select public.api_consume_provider_dispatch_permit((select task_id from ovd734_ctx), (select result_id from ovd734_ctx),
    (select permit_id from ovd734_ctx), repeat('a', 64), 'ovd734-worker-a')$$,
  '42501', null, 'authenticated cannot consume a permit');
select throws_ok(
  $$select public.api_mark_provider_dispatch_permit_side_effect_started((select permit_id from ovd734_ctx), 1, 'ovd734-worker-a')$$,
  '42501', null, 'authenticated cannot stamp a side effect');
select throws_ok(
  $$select public.api_record_provider_dispatch_permit_outcome((select permit_id from ovd734_ctx), 1, 'ovd734-worker-a', 'completed')$$,
  '42501', null, 'authenticated cannot stamp an outcome');
reset role;

savepoint ovd734_unconsumed;

-- Scenario: the first dispatch consumes; a requeued task cannot dispatch again.
select is(pg_temp.consume(), pg_temp.granted(1), 'the first consume of a fresh permit grants attempt 1');
select ok(
  (select consumption.worker_name = 'ovd734-worker-a'
      and consumption.work_queue_task_id = (select task_id from ovd734_ctx)
      and consumption.envelope_fingerprint = permit.envelope_fingerprint
      and consumption.side_effect_started_at is null and consumption.outcome is null
   from private.provider_dispatch_permit_consumptions consumption
   join private.provider_dispatch_permits permit on permit.id = consumption.permit_id
   where consumption.permit_id = (select permit_id from ovd734_ctx) and consumption.attempt = 1),
  'attempt 1 records the worker, task and envelope fingerprint, unstamped'
);
select pg_temp.requeue_to('ovd734-worker-b');
select is(pg_temp.consume('ovd734-worker-b'), pg_temp.denied('permit_already_consumed'),
  'the requeued task claimed by a second worker is refused while attempt 1 has no transient outcome');
select is(pg_temp.consume('ovd734-worker-a'), pg_temp.denied('task_inactive'),
  'the first worker''s stale claim is refused');
select pg_temp.requeue_to('ovd734-worker-a');
select is(pg_temp.mark(1, 'ovd734-worker-b') ->> 'denial', 'permit_mismatch',
  'another worker cannot stamp this attempt''s side effect');
select is(pg_temp.mark(1) -> 'sideEffectStarted', 'true'::jsonb,
  'the consuming worker stamps the side effect before its first provider action');
select is(pg_temp.mark(1) ->> 'denial', 'permit_already_consumed', 'the side effect is stamped once');
select is(pg_temp.record(1, 'transient_pre_launch_failure') ->> 'denial', 'permit_already_consumed',
  'an attempt whose side effect started cannot be recorded as transient');
select is(pg_temp.consume(), pg_temp.denied('permit_already_consumed'),
  'a second consume after the side effect started is refused');
select is(pg_temp.record(1, 'failed') ->> 'outcome', 'failed', 'the terminal outcome is stamped once');
select is(
  (select pg_catalog.count(*) from private.provider_dispatch_permit_consumptions
    where permit_id = (select permit_id from ovd734_ctx)),
  1::bigint, 'refused consumes wrote no rows');

rollback to savepoint ovd734_unconsumed;

-- Scenario: exactly one transient retry.
select is(pg_temp.consume(), pg_temp.granted(1), 'attempt 1 is granted');
select is(pg_temp.record(1, 'transient_pre_launch_failure') -> 'outcomeRecorded', 'true'::jsonb,
  'a failure before any side effect is recorded as transient');
select pg_temp.requeue_to('ovd734-worker-b');
select is(pg_temp.consume('ovd734-worker-b'), pg_temp.granted(2),
  'after a transient attempt 1 the requeued task is granted attempt 2 once');
select is(pg_temp.consume('ovd734-worker-b'), pg_temp.denied('permit_already_consumed'),
  'a third consume is refused');
select is(pg_temp.record(2, 'transient_pre_launch_failure', 'ovd734-worker-b') -> 'outcomeRecorded', 'true'::jsonb,
  'attempt 2 can also fail transiently');
select is(pg_temp.consume('ovd734-worker-b'), pg_temp.denied('permit_already_consumed'),
  'a transient attempt 2 never opens an attempt 3; the permit is exhausted');
select throws_ok(
  $$insert into private.provider_dispatch_permit_consumptions (permit_id, attempt, work_queue_task_id, worker_name, envelope_fingerprint)
    select permit_id, 3, task_id, 'ovd734-worker-b', repeat('a', 64) from ovd734_ctx$$,
  '23514', null, 'storage rejects an attempt 3 even for the table owner');

rollback to savepoint ovd734_unconsumed;

select throws_ok(
  $$insert into private.provider_dispatch_permit_consumptions (permit_id, attempt, work_queue_task_id, worker_name, envelope_fingerprint)
    select permit_id, 2, task_id, 'ovd734-worker-a', repeat('a', 64) from ovd734_ctx$$,
  '42501', null, 'storage rejects an attempt 2 without a transient attempt 1');

-- Scenario: expiry and the kill switch deny before anything is recorded.
-- Ages the stored permit with a correctly rebuilt envelope and matching task
-- fingerprint (append-only guard lifted inside the savepoint only), the same
-- way the OVD-459 preflight suite does, so only the lifetime differs.
savepoint ovd734_expired;
create function pg_temp.expire_permit()
returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_row private.provider_dispatch_permits%rowtype;
begin
  select permit.* into strict v_row
  from private.provider_dispatch_permits permit
  where permit.id = (select permit_id from ovd734_ctx);
  v_row.issued_at := pg_catalog.date_trunc('milliseconds', now() - interval '2 hours');
  v_row.expires_at := pg_catalog.date_trunc('milliseconds', now() - interval '1 hour');
  v_row.envelope := private.build_provider_dispatch_envelope(
    v_row.provider, v_row.envelope_id, v_row.envelope_version, v_row.admission_policy_revision,
    v_row.admission_evidence_reference, v_row.notice_revision, v_row.actor_user_id,
    v_row.organization_id, v_row.job_id, v_row.part_id, v_row.scope_version, v_row.scope_fingerprint,
    v_row.requested_quantity, v_row.declared_model_units, v_row.cad_file_id, v_row.cad_sha256,
    v_row.drawing_file_id, v_row.drawing_sha256, v_row.quote_request_id, v_row.quote_run_id,
    v_row.vendor_quote_result_id, v_row.quote_request_lane_id, v_row.work_queue_task_id, v_row.id,
    v_row.approval_reference, v_row.session_binding_id, v_row.rollout_revision, v_row.issued_at,
    v_row.expires_at
  );
  v_row.canonical_envelope := v_row.envelope::text;
  v_row.envelope_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_row.canonical_envelope, 'UTF8')), 'hex');
  alter table private.provider_dispatch_permits disable trigger provider_dispatch_permits_append_only;
  update private.provider_dispatch_permits
  set issued_at = v_row.issued_at, expires_at = v_row.expires_at, envelope = v_row.envelope,
    canonical_envelope = v_row.canonical_envelope, envelope_fingerprint = v_row.envelope_fingerprint
  where id = v_row.id;
  alter table private.provider_dispatch_permits enable trigger provider_dispatch_permits_append_only;
  update public.work_queue
  set payload = payload || pg_catalog.jsonb_build_object('providerDispatchEnvelopeFingerprint', v_row.envelope_fingerprint)
  where id = v_row.work_queue_task_id;
end;
$$;
select pg_temp.expire_permit();
select is(pg_temp.consume(), pg_temp.denied('permit_expired'), 'an expired permit is refused');
rollback to savepoint ovd734_expired;

savepoint ovd734_provider_switch;
update private.provider_kill_switches set engaged = true where provider = 'fictiv';
select is(pg_temp.consume(), pg_temp.denied('provider_kill_switch_engaged'), 'an engaged provider kill switch refuses');
rollback to savepoint ovd734_provider_switch;
savepoint ovd734_global_switch;
update private.provider_global_kill_switch set engaged = true where singleton;
select is(pg_temp.consume(), pg_temp.denied('provider_kill_switch_engaged'), 'an engaged global kill switch refuses');
rollback to savepoint ovd734_global_switch;
savepoint ovd734_missing_switch;
delete from private.provider_kill_switches where provider = 'fictiv';
select is(pg_temp.consume(), pg_temp.denied('provider_kill_switch_engaged'), 'a missing provider switch row counts as engaged');
rollback to savepoint ovd734_missing_switch;
savepoint ovd734_missing_tables;
alter table private.provider_global_kill_switch rename to provider_global_kill_switch_ovd734_hidden;
select is(pg_temp.consume(), pg_temp.denied('provider_kill_switch_engaged'),
  'without the OVD-722 tables every consume is refused (fail closed)');
rollback to savepoint ovd734_missing_tables;
select is(
  (select pg_catalog.count(*) from private.provider_dispatch_permit_consumptions
    where permit_id = (select permit_id from ovd734_ctx)),
  0::bigint, 'denied consumes recorded nothing, so the permit is still unconsumed');

-- Scenario: rows cannot be rewritten or removed.
select is(pg_temp.consume(), pg_temp.granted(1), 'fixture: attempt 1 is granted');
set local role service_role;
select throws_ok($$update private.provider_dispatch_permit_consumptions set outcome = 'completed'$$,
  '42501', null, 'service_role cannot update consumption rows directly');
reset role;
select throws_ok($$update private.provider_dispatch_permit_consumptions set worker_name = 'ovd734-forged'$$,
  '42501', null, 'identity columns cannot be rewritten');
select throws_ok($$delete from private.provider_dispatch_permit_consumptions$$,
  '42501', null, 'consumption rows cannot be deleted');
select throws_ok($$truncate private.provider_dispatch_permit_consumptions$$,
  '42501', null, 'the consumption table cannot be truncated');
select is(pg_temp.record(1, 'completed') ->> 'outcome', 'completed', 'fixture: the outcome is stamped');
select throws_ok($$update private.provider_dispatch_permit_consumptions set outcome = 'failed'$$,
  '42501', null, 'a stamped outcome cannot be changed');
select throws_ok($$update private.provider_dispatch_permit_consumptions set side_effect_started_at = clock_timestamp()$$,
  '42501', null, 'a side effect cannot be stamped after the attempt ended');

select * from finish();
rollback;
