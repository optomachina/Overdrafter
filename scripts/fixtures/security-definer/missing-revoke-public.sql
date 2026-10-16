create or replace function public.fixture_no_revoke_public(p_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$ select p_id is not null $$;

revoke execute on function public.fixture_no_revoke_public(uuid) from anon;
grant execute on function public.fixture_no_revoke_public(uuid) to authenticated;
