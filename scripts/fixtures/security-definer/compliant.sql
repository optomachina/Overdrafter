-- Fully compliant SECURITY DEFINER functions in the shapes the migrations use.
create or replace function public.fixture_compliant(
  p_id uuid,
  p_label text default 'x',
  out p_ok boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  p_ok := p_id is not null;
end;
$$;

revoke all on function public.fixture_compliant(uuid, text) from public, anon;
grant execute on function public.fixture_compliant(uuid, text) to authenticated;

create function "Private".fixture_pinned_list(p_at timestamptz, p_ids int4[])
returns integer language sql security definer set search_path = pg_catalog, extensions as $body$
  select coalesce(array_length(p_ids, 1), 0)
$body$;

revoke execute on function "Private".fixture_pinned_list(timestamp with time zone, integer[]) from public;
revoke execute on function "Private".fixture_pinned_list(timestamp with time zone, integer[]) from anon;
grant execute on function "Private".fixture_pinned_list(timestamp with time zone, integer[]) to service_role;

-- search_path pinned afterwards with ALTER FUNCTION in the same migration.
create or replace function public.fixture_altered()
returns void language sql security definer as $$ select $$;
alter function public.fixture_altered() set search_path = '';
revoke all on function public.fixture_altered() from public, anon, authenticated;
grant execute on function public.fixture_altered() to service_role;
