\set ON_ERROR_STOP on

-- Serialize with the legacy production deployment path first, then hold the
-- OVD-418 database-release mutex and every commercial rollout mutex for the
-- lifetime of the release runner's psql session.
select pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('ovd373-production-deployment', 0)
);
select pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('ovd418-production-database-release', 0)
);
select pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('commercial-rollout:automatic_quote_collection', 0)
);
select pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('commercial-rollout:commercial_admin_mutations', 0)
);
select pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('commercial-rollout:order_administration', 0)
);
select pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('commercial-rollout:promotion_codes', 0)
);

\ir verify-ovd418-production-preconditions.sql

select 'OVD-418 production release locks acquired.' as result;
select pg_catalog.pg_sleep(2147483647);
