-- create table public.fixture_in_comment (id uuid);
/* create table public.fixture_in_block_comment (id uuid); */
create function public.fixture_ddl_in_body() returns void language plpgsql as $$
begin
  create table public.fixture_in_body (id uuid);
end;
$$;
select 'create table public.fixture_in_string (id uuid)';
create table private.fixture_private (id uuid primary key);
