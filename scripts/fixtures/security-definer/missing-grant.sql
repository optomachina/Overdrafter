create or replace function public.fixture_no_grant(p_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$ select p_id is not null $$;

revoke all on function public.fixture_no_grant(uuid) from public, anon;
