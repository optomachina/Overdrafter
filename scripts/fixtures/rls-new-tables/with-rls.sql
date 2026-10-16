create table public.fixture_with_rls (
  id uuid primary key,
  label text not null
);

alter table public.fixture_with_rls enable row level security;

create table overdrafter.fixture_overdrafter_rls (id uuid primary key);

alter table overdrafter.fixture_overdrafter_rls
  add column note text,
  enable row level security;
