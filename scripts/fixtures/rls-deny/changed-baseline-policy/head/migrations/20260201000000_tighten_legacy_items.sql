-- Fixture: a baseline policy is replaced without adding tagged deny tests.
drop policy if exists "legacy_items_select_own" on public.legacy_items;

create policy "legacy_items_select_own"
on public.legacy_items
for select
to authenticated
using (owner_id = (select auth.uid()));
