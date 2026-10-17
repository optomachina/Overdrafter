-- The baselined function re-created, still non-compliant, in a new migration.
create or replace function public.fixture_legacy(p_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$ select p_id is not null $$;
