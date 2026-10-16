-- SECURITY DEFINER appears only in comments, strings and function bodies here.
/* create function public.fixture_commented() returns void security definer as $$ $$; */
create or replace function public.fixture_invoker_body()
returns text
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  -- this is not security definer
  perform 'create function public.x() returns void security definer as $$ $$';
  return 'security definer';
end;
$fn$;

create or replace function public.fixture_quoted_body()
returns text
language sql
as 'select ''security definer''';

select 'create or replace function public.y() returns void security definer as $$ $$;';
comment on function public.fixture_invoker_body() is 'Not SECURITY DEFINER.';
