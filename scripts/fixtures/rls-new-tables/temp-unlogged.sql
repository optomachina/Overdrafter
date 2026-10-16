create temporary table fixture_scratch (id uuid) on commit drop;
create temp table if not exists pg_temp.fixture_scratch_two (id uuid);

create unlogged table public.fixture_staging (id uuid);
insert into public.fixture_staging select gen_random_uuid();
drop table if exists public.fixture_staging;

create unlogged table public.fixture_unlogged_kept (id uuid);
