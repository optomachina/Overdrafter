-- OVD-418 aggregate-only production ledger evidence.
--
-- This script binds the live ledger to the previously verified OVD-373
-- production lineage and records statement hashes for the reviewed suffix.
-- It never reads application or customer tables.

begin read only;

with package(version, sha256) as (
  values
    ('20260817133902', '331ee2d9282142ab7134f179a9b7d8b93ce64027ad6d909c0a183a2874a64d2b'),
    ('20260821223849', '0e2981089cf0a0d32de2c5a147cc59603269e27be37eb59a4574e677a4aae0f0'),
    ('20260821223851', '18130f708bff981e7eb8ce5100baa0031ed89904c89918f47a9cc6ce94c8ec09'),
    ('20260822213330', '65acdfaff16524eda49f15544989662b52c9dba44e4fd18ba538ca2052d1dc86')
), ovd373_suffix(version) as (
  values
    ('20260330144838'), ('20260331000000'), ('20260331000001'), ('20260331010000'),
    ('20260402100000'), ('20260402120000'), ('20260403103000'), ('20260405103000'),
    ('20260406000000'), ('20260408120000'), ('20260408193000'), ('20260409000000'),
    ('20260514120000'), ('20260514120100'), ('20260725090000'), ('20260728190000'),
    ('20260731015300'), ('20260731015400'), ('20260815090000'), ('20260815093000'),
    ('20260815100000'), ('20260815184740'), ('20260816011204'), ('20260816015000'),
    ('20260816015500') -- NOSONAR: the frozen OVD-373 boundary is intentionally repeated across independent continuity checks.
), baseline as (
  select
    pg_catalog.count(*) as count,
    pg_catalog.max(version::text) as head,
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n' order by version::text
      )
    ) as fingerprint
  from supabase_migrations.schema_migrations
  where version::text <= '20260817054500' -- NOSONAR: the frozen production baseline is intentionally repeated in independently auditable checks.
), ovd373_prefix as (
  select
    pg_catalog.count(*) as count,
    pg_catalog.max(version::text) as head,
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n' order by version::text
      )
    ) as fingerprint
  from supabase_migrations.schema_migrations
  where version::text <= '20260816015500'
), ovd373_original as (
  select
    pg_catalog.count(*) as count,
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n' order by version::text
      )
    ) as fingerprint
  from supabase_migrations.schema_migrations
  where version::text <= '20260816015500'
    and version::text not in (select version from ovd373_suffix)
), ledger as (
  select
    pg_catalog.count(*) as count,
    pg_catalog.max(version::text) as head,
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n' order by version::text
      )
    ) as fingerprint
  from supabase_migrations.schema_migrations
)
select pg_catalog.jsonb_build_object(
  'sourceSha', '5c3b6864e63ada75561f4ff7019bde70962d6e39',
  'migrationHashes', (
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('version', version, 'sha256', sha256) -- NOSONAR: stable evidence keys intentionally repeat across nested objects.
      order by version
    )
    from package
  ),
  'productionContinuity', pg_catalog.jsonb_build_object(
    'ovd373Prefix', pg_catalog.jsonb_build_object(
      'count', ovd373_prefix.count,
      'head', ovd373_prefix.head,
      'fingerprint', ovd373_prefix.fingerprint
    ),
    'ovd373OriginalSubset', pg_catalog.jsonb_build_object(
      'count', ovd373_original.count,
      'fingerprint', ovd373_original.fingerprint
    ),
    'row100', pg_catalog.jsonb_build_object(
      'version', (
        select version::text
        from supabase_migrations.schema_migrations
        where version::text = '20260817054500'
      ),
      'statementHash', (
        select pg_catalog.md5(pg_catalog.to_json(statements)::text)
        from supabase_migrations.schema_migrations
        where version::text = '20260817054500'
      )
    )
  ),
  'baselineCount', baseline.count,
  'baselineHead', baseline.head,
  'baselineFingerprint', baseline.fingerprint,
  'packageVersions', (
    select coalesce(
      pg_catalog.jsonb_agg(version::text order by version::text),
      '[]'::jsonb
    )
    from supabase_migrations.schema_migrations
    where version::text in (select version from package)
  ),
  'packageStatementHashes', (
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'version', version::text,
          'statementHash', pg_catalog.md5(pg_catalog.to_json(statements)::text)
        )
        order by version::text
      ),
      '[]'::jsonb
    )
    from supabase_migrations.schema_migrations
    where version::text in (select version from package)
  ),
  'unexpectedVersionCount', (
    select pg_catalog.count(*)
    from supabase_migrations.schema_migrations
    where version::text > '20260817054500'
      and version::text not in (select version from package)
  ),
  'ledgerCount', ledger.count,
  'ledgerHead', ledger.head,
  'ledgerFingerprint', ledger.fingerprint
) as ovd418_production_ledger
from baseline
cross join ovd373_prefix -- NOSONAR: each aggregate CTE is guaranteed to return exactly one row.
cross join ovd373_original -- NOSONAR: each aggregate CTE is guaranteed to return exactly one row.
cross join ledger; -- NOSONAR: each aggregate CTE is guaranteed to return exactly one row.

commit;
