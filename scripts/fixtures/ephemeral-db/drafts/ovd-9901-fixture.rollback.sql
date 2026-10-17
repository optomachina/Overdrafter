-- OVD-849 fixture rollback for ovd-9901-fixture.sql. The ephemeral job never applies rollbacks.
drop table if exists public.ephemeral_fixture_draft;
