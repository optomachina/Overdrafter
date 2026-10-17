-- A pre-existing violation recorded in the baseline.
create or replace function public.fixture_legacy(p_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$ select p_id is not null $$;
