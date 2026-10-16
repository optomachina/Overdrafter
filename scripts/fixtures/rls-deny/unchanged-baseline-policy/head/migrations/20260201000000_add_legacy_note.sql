-- Fixture: a migration that leaves every RLS policy untouched.
alter table public.legacy_items add column note text;
