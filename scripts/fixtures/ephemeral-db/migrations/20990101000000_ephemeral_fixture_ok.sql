-- OVD-849 fixture: a trivial migration the ephemeral database applies cleanly.
-- Lives under scripts/fixtures on purpose: never copy it into supabase/migrations on main.
create table if not exists public.ephemeral_fixture_ok (
  id bigint generated always as identity primary key,
  note text not null default 'ok'
);
