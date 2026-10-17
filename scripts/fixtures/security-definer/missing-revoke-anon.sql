create or replace function public.fixture_no_revoke_anon(p_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$ select p_id is not null $$;

revoke all on function public.fixture_no_revoke_anon(uuid) from public;
grant execute on function public.fixture_no_revoke_anon(uuid) to authenticated;
