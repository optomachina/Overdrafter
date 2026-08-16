\set ON_ERROR_STOP on

select pg_catalog.pg_advisory_lock(
  pg_catalog.hashtextextended('ovd373-production-deployment', 0)
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

\ir verify-ovd373-rollout-preconditions.sql

select 'OVD-373 deployment locks acquired.' as result;
select pg_catalog.pg_sleep(2147483647);
