-- Fixture: an existing table and policy that predate the deny-tag convention.
create table public.legacy_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null
);

alter table public.legacy_items enable row level security;

create policy "legacy_items_select_own"
on public.legacy_items
for select
to authenticated
using (owner_id = auth.uid());
