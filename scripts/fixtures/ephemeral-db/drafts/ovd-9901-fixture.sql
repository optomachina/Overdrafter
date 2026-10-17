-- OVD-849 fixture draft (family 9901): applies cleanly. Claimed by
-- pending/ovd9901_fixture.sql.pending. Never copy it into supabase/migrations.
create table if not exists public.ephemeral_fixture_draft (
  id bigint generated always as identity primary key
);
