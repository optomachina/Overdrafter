-- This test commits a temporary rollout decision so independent dblink
-- sessions can exercise the real advisory lock. It restores the exact default
-- state and removes only its fixed test events before finishing.

create extension if not exists dblink with schema extensions;

select plan(3);

do $$
begin
  if current_database() <> 'postgres'
     or session_user <> 'postgres'
     or exists (
       select 1
       from private.commercial_rollout_control_events
       where capability = 'automatic_quote_collection'
     )
     or exists (
       select 1
       from private.commercial_rollout_controls
       where capability = 'automatic_quote_collection'
         and (enabled or revision <> 0)
     )
  then
    raise exception
      'OVD-313 concurrency tests require a freshly reset disposable local database';
  end if;
end;
$$;

select extensions.dblink_connect(
  'ovd313_a',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);
select extensions.dblink_connect(
  'ovd313_b',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);

select extensions.dblink_send_query(
  'ovd313_a',
  $query$
    select public.api_set_commercial_rollout_control(
      'automatic_quote_collection',
      true,
      'Concurrent exact retry verification',
      'concurrency-test@example.com',
      0,
      'ovd313-concurrent-enable'
    )
  $query$
);
select extensions.dblink_send_query(
  'ovd313_b',
  $query$
    select public.api_set_commercial_rollout_control(
      'automatic_quote_collection',
      true,
      'Concurrent exact retry verification',
      'concurrency-test@example.com',
      0,
      'ovd313-concurrent-enable'
    )
  $query$
);

create temporary table ovd313_concurrent_results (
  result jsonb not null
);

insert into ovd313_concurrent_results
select result
from extensions.dblink_get_result('ovd313_a') as response(result jsonb);
insert into ovd313_concurrent_results
select result
from extensions.dblink_get_result('ovd313_b') as response(result jsonb);
select *
from extensions.dblink_get_result('ovd313_a') as response(result jsonb);
select *
from extensions.dblink_get_result('ovd313_b') as response(result jsonb);

select is(
  (
    select count(*)
    from ovd313_concurrent_results
    where (result ->> 'replayed')::boolean
  ),
  1::bigint,
  'two concurrent exact actions return one replay'
);

select is(
  (
    select count(*)
    from private.commercial_rollout_control_events
    where capability = 'automatic_quote_collection'
      and idempotency_key = 'ovd313-concurrent-enable'
  ),
  1::bigint,
  'two concurrent exact actions append one audit event'
);

select ok(
  (
    select enabled and revision = 1
    from private.commercial_rollout_controls
    where capability = 'automatic_quote_collection'
  ),
  'the concurrent action commits one state revision'
);

select extensions.dblink_disconnect('ovd313_a');
select extensions.dblink_disconnect('ovd313_b');

begin;

alter table private.commercial_rollout_control_events
  disable trigger reject_commercial_rollout_control_event_mutation;
delete from private.commercial_rollout_control_events
where capability = 'automatic_quote_collection'
  and idempotency_key = 'ovd313-concurrent-enable';
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
where capability = 'automatic_quote_collection';

commit;

select * from finish();
