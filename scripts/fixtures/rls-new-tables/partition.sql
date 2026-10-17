create table public.fixture_events (
  id uuid not null,
  occurred_at timestamptz not null
) partition by range (occurred_at);

alter table public.fixture_events enable row level security;

create table public.fixture_events_2099 partition of public.fixture_events
  for values from ('2099-01-01') to ('2100-01-01');

create table public.fixture_partitioned_no_rls (
  id uuid not null
) partition by hash (id);
