-- Fixture: policy text inside function bodies, string literals and comments
-- is not a policy change.
-- create policy commented_out on public.legacy_items using (true);
/* drop policy "legacy_items_select_own" on public.legacy_items; */
create or replace function public.describe_policies()
returns text
language plpgsql
as $$
begin
  execute 'create policy dynamic_policy on public.legacy_items using (true)';
  return 'alter table public.legacy_items disable row level security; create policy x on public.y using (true)';
end;
$$;

create or replace function public.describe_policies_tagged()
returns text
language sql
as $body$
  select 'drop policy if exists legacy_items_select_own on public.legacy_items; alter table public.legacy_items disable row level security'::text
$body$;

comment on function public.describe_policies() is 'create policy in_a_string on public.legacy_items; alter table public.legacy_items disable row level security';
