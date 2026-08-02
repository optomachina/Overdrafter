-- This test commits fixed rollout events so two dblink sessions can exercise
-- the real shared/exclusive advisory-lock ordering. It restores the exact
-- default state and removes only its own events before finishing.

create extension if not exists dblink with schema extensions;

select plan(2);

create temporary table ovd314_concurrency_constants (
  rollout_capability text not null,
  request_connection text not null,
  disable_connection text not null,
  request_backend_pid integer,
  disable_backend_pid integer
) on commit preserve rows;

insert into ovd314_concurrency_constants values (
  'automatic_quote_collection',
  'ovd314_request',
  'ovd314_disable',
  null,
  null
);

create function pg_temp.ovd314_disable_waiting_on_request()
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
    from pg_catalog.pg_locks waiting_lock
    join pg_catalog.pg_locks held_lock
      on held_lock.locktype = waiting_lock.locktype
     and held_lock.database is not distinct from waiting_lock.database
     and held_lock.classid is not distinct from waiting_lock.classid
     and held_lock.objid is not distinct from waiting_lock.objid
     and held_lock.objsubid is not distinct from waiting_lock.objsubid
    where waiting_lock.pid = (
      select disable_backend_pid
      from pg_temp.ovd314_concurrency_constants
    )
      and held_lock.pid = (
        select request_backend_pid
        from pg_temp.ovd314_concurrency_constants
      )
      and waiting_lock.locktype = 'advisory'
      and not waiting_lock.granted
      and held_lock.granted
  );
$$;

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
  (select request_connection from ovd314_concurrency_constants),
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);
select extensions.dblink_connect(
  (select disable_connection from ovd314_concurrency_constants),
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);

update ovd314_concurrency_constants
set
  request_backend_pid = (
    select backend_pid
    from extensions.dblink(
      (select request_connection from ovd314_concurrency_constants),
      'select pg_catalog.pg_backend_pid()'
    ) as response(backend_pid integer)
  ),
  disable_backend_pid = (
    select backend_pid
    from extensions.dblink(
      (select disable_connection from ovd314_concurrency_constants),
      'select pg_catalog.pg_backend_pid()'
    ) as response(backend_pid integer)
  );

select extensions.dblink_exec(
  (select request_connection from ovd314_concurrency_constants),
  'begin'
);
select extensions.dblink_exec(
  (select request_connection from ovd314_concurrency_constants),
  $query$
    do $remote$
    begin
      perform private.automatic_quote_rollout_enabled_with_lock();
    end;
    $remote$
  $query$
);

select extensions.dblink_send_query(
  (select disable_connection from ovd314_concurrency_constants),
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

do $$
declare
  v_attempt integer;
begin
  for v_attempt in 1..100 loop
    exit when pg_temp.ovd314_disable_waiting_on_request();

    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;

select ok(
  pg_temp.ovd314_disable_waiting_on_request(),
  'audited disablement waits on the in-flight request advisory lock'
);

select extensions.dblink_exec(
  (select request_connection from ovd314_concurrency_constants),
  'commit'
);

create temporary table ovd314_disable_result (
  result jsonb not null
);

insert into ovd314_disable_result
select result
from extensions.dblink_get_result(
  (select disable_connection from ovd314_concurrency_constants)
) as response(result jsonb);
select *
from extensions.dblink_get_result(
  (select disable_connection from ovd314_concurrency_constants)
) as response(result jsonb);

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

select extensions.dblink_disconnect(
  (select request_connection from ovd314_concurrency_constants)
);
select extensions.dblink_disconnect(
  (select disable_connection from ovd314_concurrency_constants)
);

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
