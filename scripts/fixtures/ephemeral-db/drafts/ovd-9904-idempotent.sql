-- OVD-924 fixture draft (family 9904): header declares idempotent, applies cleanly.
-- ovd: idempotent
-- Claimed by pending/ovd9904_idempotent.sql.pending. Never copy into supabase/migrations.
create table if not exists public.ephemeral_fixture_idempotent (
  id bigint generated always as identity primary key
);
