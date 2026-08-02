-- This test commits fixed rollout events so two dblink sessions can exercise
-- the real shared/exclusive advisory-lock ordering. It restores the exact
-- default state and removes only its own events before finishing.

create extension if not exists dblink with schema extensions;

select plan(2);

create temporary table ovd314_concurrency_constants (
  rollout_capability text not null
) on commit preserve rows;

insert into ovd314_concurrency_constants values (
  'automatic_quote_collection'
);

do $$
begin
  if current_database() <> 'postgres'
     or session_user <> 'postgres'
     or exists (
       select 1
       from private.commercial_rollout_control_events
       where capability = (
         select rollout_capability
         from ovd314_concurrency_constants
       )
     )
     or exists (
       select 1
       from private.commercial_rollout_controls
       where capability = (
         select rollout_capability
         from ovd314_concurrency_constants
       )
         and (enabled or revision <> 0)
     )
  then
    raise exception
      'OVD-314 concurrency tests require a freshly reset disposable local database';
  end if;
end;
$$;

select public.api_set_commercial_rollout_control(
  (select rollout_capability from ovd314_concurrency_constants),
  true,
  'Enable OVD-314 disposable concurrency verification',
  'ovd314-concurrency-test',
  0,
  'ovd314-concurrency-enable'
);

select extensions.dblink_connect(
  'ovd314_request',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);
select extensions.dblink_connect(
  'ovd314_disable',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);

select extensions.dblink_exec('ovd314_request', 'begin');
select extensions.dblink_exec(
  'ovd314_request',
  $query$
    do $remote$
    begin
      perform private.automatic_quote_rollout_enabled_with_lock();
    end;
    $remote$
  $query$
);

select extensions.dblink_send_query(
  'ovd314_disable',
  pg_catalog.format(
    $query$
      select public.api_set_commercial_rollout_control(
      %L,
      false,
      'Disable after the in-flight automatic request finishes',
      'ovd314-concurrency-test',
      1,
      'ovd314-concurrency-disable'
    )
    $query$,
    (
      select rollout_capability
      from ovd314_concurrency_constants
    )
  )
);

select pg_catalog.pg_sleep(0.1);

select is(
  extensions.dblink_is_busy('ovd314_disable'),
  1,
  'audited disablement waits for the in-flight automatic request transaction'
);

select extensions.dblink_exec('ovd314_request', 'commit');

create temporary table ovd314_disable_result (
  result jsonb not null
);

insert into ovd314_disable_result
select result
from extensions.dblink_get_result('ovd314_disable') as response(result jsonb);
select *
from extensions.dblink_get_result('ovd314_disable') as response(result jsonb);

select is(
  (
    select pg_catalog.jsonb_build_array(
      result ->> 'enabled',
      result ->> 'revision'
    )
    from ovd314_disable_result
  ),
  '["false", "2"]'::jsonb,
  'disablement commits immediately after the in-flight request finishes'
);

select extensions.dblink_disconnect('ovd314_request');
select extensions.dblink_disconnect('ovd314_disable');

begin;

alter table private.commercial_rollout_control_events
  disable trigger reject_commercial_rollout_control_event_mutation;
delete from private.commercial_rollout_control_events
where idempotency_key in (
  'ovd314-concurrency-enable',
  'ovd314-concurrency-disable'
);
alter table private.commercial_rollout_control_events
  enable trigger reject_commercial_rollout_control_event_mutation;

update private.commercial_rollout_controls
set
  enabled = false,
  revision = 0,
  change_reason = 'Default-off automatic quote rollout',
  updated_at = pg_catalog.now(),
  updated_by_user_id = null,
  updated_by_actor = null
where capability = (
  select rollout_capability
  from ovd314_concurrency_constants
);

commit;

select * from finish();
