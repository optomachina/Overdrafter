-- Fixture: a new owner-scoped table and policy.
create table public.widgets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null
);

alter table public.widgets enable row level security;

create policy widgets_select_own
on public.widgets
for select
to authenticated
using (owner_id = auth.uid());
