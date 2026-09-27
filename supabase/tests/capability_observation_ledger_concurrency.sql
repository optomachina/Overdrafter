-- OVD-512: synthetic, isolated-database proof of concurrent canonical replay.
-- The fixture runner supplies an ephemeral, container-local connection string.
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select plan(7);

create function private.ovd512_race_call(
  p_key text,
  p_accept boolean,
  p_extensions text[]
) returns bigint language sql set search_path = pg_catalog as $$
  select private.record_capability_observation(
    'xometry', 'provider_upload', 'quote_home', 'account_quote_modal',
    'xometry-account-quote-modal.v1', 'provider-upload-capability.v1', 'fresh',
    p_extensions, array['application/step']::text[], p_accept,
    timestamptz '2026-09-11 02:00:00+00',
    timestamptz '2026-09-12 04:00:00+00',
    'worker', 'provider_surface', 'worker.v1', 'issue:OVD-512', p_key,
    case when p_key = 'ovd-512:race-conflict' then 2 else 1 end
  );
$$;

create function pg_temp.ovd512_race_wait_for_two() returns boolean
language plpgsql set search_path = pg_catalog as $$
begin
  for attempt in 1..150 loop
    perform pg_catalog.pg_stat_clear_snapshot();
    if (select pg_catalog.count(*) from pg_catalog.pg_stat_activity
        where application_name = 'ovd512-race' and wait_event_type = 'Lock') = 2 then
      return true;
    end if;
    perform pg_catalog.pg_sleep(0.02);
  end loop;
  return false;
end;
$$;

create function pg_temp.ovd512_race_result(p_connection text) returns jsonb
language plpgsql set search_path = pg_catalog as $$
declare v_id bigint;
begin
  select id into v_id from extensions.dblink_get_result(p_connection) as row(id bigint);
  return pg_catalog.jsonb_build_object('id', v_id, 'sqlstate', null);
exception when others then
  return pg_catalog.jsonb_build_object('id', null, 'sqlstate', sqlstate);
end;
$$;

select extensions.dblink_connect('ovd512-a', current_setting('ovd.test_conninfo'));
select extensions.dblink_connect('ovd512-b', current_setting('ovd.test_conninfo'));

-- Hold the same lock the append primitive takes. Both calls must be waiting
-- before release; otherwise sequential success could masquerade as a race.
begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  'capability-observation:idempotency:ovd-512:race-same', 0));
select extensions.dblink_send_query('ovd512-a',
  $$select private.ovd512_race_call('ovd-512:race-same', false, array['.STEP', 'stp'])$$);
select extensions.dblink_send_query('ovd512-b',
  $$select private.ovd512_race_call('ovd-512:race-same', false, array['step', '.STP'])$$);
select ok(pg_temp.ovd512_race_wait_for_two(), 'identical replays both wait on the ordered lock');
commit;

create temporary table ovd512_race_results (case_name text, result jsonb);
insert into ovd512_race_results values
  ('same', pg_temp.ovd512_race_result('ovd512-a')),
  ('same', pg_temp.ovd512_race_result('ovd512-b'));
-- dblink sends can return more than one result frame. Drain the completion
-- frame before reusing either connection for the second concurrent case.
select * from extensions.dblink_get_result('ovd512-a') as response(id bigint);
select * from extensions.dblink_get_result('ovd512-b') as response(id bigint);
select ok((select count(*) = 2 and count(distinct result ->> 'id') = 1
  from ovd512_race_results where case_name = 'same'
    and result ->> 'sqlstate' is null and result ->> 'id' is not null),
  'both concurrent canonical replays succeed with the same row id');
select is((select count(*)::integer from private.capability_observations
  where idempotency_key = 'ovd-512:race-same'), 1,
  'concurrent canonical replays append one row');

begin;
select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  'capability-observation:idempotency:ovd-512:race-conflict', 0));
select extensions.dblink_send_query('ovd512-a',
  $$select private.ovd512_race_call('ovd-512:race-conflict', false, array['step'])$$);
select extensions.dblink_send_query('ovd512-b',
  $$select private.ovd512_race_call('ovd-512:race-conflict', true, array['step'])$$);
select ok(pg_temp.ovd512_race_wait_for_two(), 'conflicting replays both wait on the ordered lock');
commit;

insert into ovd512_race_results values
  ('conflict', pg_temp.ovd512_race_result('ovd512-a')),
  ('conflict', pg_temp.ovd512_race_result('ovd512-b'));
select is((select count(*)::integer from ovd512_race_results
  where case_name = 'conflict' and result ->> 'id' is not null), 1,
  'one conflicting replay wins');
select is((select count(*)::integer from ovd512_race_results
  where case_name = 'conflict' and result ->> 'sqlstate' = '23505'), 1,
  'the conflicting replay rejects with the unique-conflict SQLSTATE');
select is((select count(*)::integer from private.capability_observations
  where idempotency_key = 'ovd-512:race-conflict'), 1,
  'conflicting replays append one row');

select extensions.dblink_disconnect('ovd512-a');
select extensions.dblink_disconnect('ovd512-b');
drop function private.ovd512_race_call(text, boolean, text[]);
select * from finish();
