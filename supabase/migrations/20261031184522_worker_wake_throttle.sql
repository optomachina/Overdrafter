-- Global, bounded singleton: at most one wake sequence per ten seconds across isolates.
create table private.worker_wake_throttle (
  singleton boolean primary key default true check (singleton),
  next_allowed_at timestamptz not null default '-infinity'
);
insert into private.worker_wake_throttle (singleton) values (true);
alter table private.worker_wake_throttle enable row level security;
alter table private.worker_wake_throttle force row level security;
revoke all on private.worker_wake_throttle from public, anon, authenticated, service_role;

create function public.api_take_worker_wake_slot()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.worker_wake_throttle
  set next_allowed_at = clock_timestamp() + interval '10 seconds'
  where singleton and next_allowed_at <= clock_timestamp();
  return found;
end;
$$;
revoke all on function public.api_take_worker_wake_slot() from public, anon, authenticated;
grant execute on function public.api_take_worker_wake_slot() to service_role;
comment on function public.api_take_worker_wake_slot() is
  'Service-only atomic global wake throttle; no caller-controlled keys or intervals.';
