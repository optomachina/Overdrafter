create or replace function public.fixture_no_search_path(p_id uuid)
returns boolean
language sql
security definer
as $$ select p_id is not null $$;

revoke all on function public.fixture_no_search_path(uuid) from public, anon;
grant execute on function public.fixture_no_search_path(uuid) to authenticated;
