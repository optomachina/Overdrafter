-- OVD-849 fixture: a migration that must fail, so the report names this file.
-- public.ephemeral_fixture_missing never exists.
alter table public.ephemeral_fixture_missing add column note text;
