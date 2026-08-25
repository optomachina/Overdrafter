-- OVD-418 hosted production pre-release verification.
--
-- Read-only by construction. This script inspects only the migration ledger,
-- the four commercial rollout controls, active-work aggregates, and the total
-- vendor-offer count used by the release runner for before/after comparison.
-- It emits no customer or provider row identity or content.

begin read only;
set local ovd418.audit_phase = 'precondition';
\ir verify-ovd418-production-quiescence.sql

-- Ledger classification is intentionally deferred to the release runner.
-- This gate must remain usable from exact baseline, partial-one recovery, and
-- already-final states while still refusing unsafe operational state.

with ovd373_prefix as (
  select
    pg_catalog.count(*) as migration_count,
    pg_catalog.max(version::text) as migration_head,
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n'
        order by version::text
      )
    ) as migration_fingerprint
  from supabase_migrations.schema_migrations
  where version::text <= '20260816015500' -- NOSONAR: the frozen OVD-373 boundary is intentionally repeated across independent continuity checks.
), ovd373_original_subset as (
  select
    pg_catalog.count(*) as migration_count,
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n'
        order by version::text
      )
    ) as migration_fingerprint
  from supabase_migrations.schema_migrations
  where version::text <= '20260816015500'
    and not (version::text = any (array[
      '20260330144838', '20260331000000', '20260331000001', '20260331010000',
      '20260402100000', '20260402120000', '20260403103000', '20260405103000',
      '20260406000000', '20260408120000', '20260408193000', '20260409000000',
      '20260514120000', '20260514120100', '20260725090000', '20260728190000',
      '20260731015300', '20260731015400', '20260815090000', '20260815093000',
      '20260815100000', '20260815184740', '20260816011204', '20260816015000',
      '20260816015500'
    ]))
), row_100 as (
  select
    pg_catalog.count(*) as migration_count,
    pg_catalog.max(version::text) as migration_version,
    pg_catalog.max(
      pg_catalog.md5(pg_catalog.to_json(statements)::text)
    ) as statement_hash
  from supabase_migrations.schema_migrations
  where version::text = '20260817054500' -- NOSONAR: the frozen production baseline is intentionally repeated in independently auditable checks.
), baseline as (
  select
    pg_catalog.count(*) as migration_count,
    pg_catalog.max(version::text) as migration_head,
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n'
        order by version::text
      )
    ) as migration_fingerprint
  from supabase_migrations.schema_migrations
  where version::text <= '20260817054500'
), ledger as (
  select
    pg_catalog.count(*) as migration_count,
    pg_catalog.max(version::text) as migration_head,
    pg_catalog.md5(
      pg_catalog.string_agg(
        version::text || ':' || pg_catalog.md5(pg_catalog.to_json(statements)::text),
        E'\n'
        order by version::text
      )
    ) as migration_fingerprint
  from supabase_migrations.schema_migrations
), suffix as (
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'version', version::text, -- NOSONAR: stable evidence keys intentionally repeat across nested objects.
        'statementHash', pg_catalog.md5(pg_catalog.to_json(statements)::text)
      )
      order by version::text
    ),
    '[]'::jsonb
  ) as statement_hashes
  from supabase_migrations.schema_migrations
  where version::text > '20260817054500'
)
select pg_catalog.jsonb_build_object(
  'sourceSha', '5c3b6864e63ada75561f4ff7019bde70962d6e39',
  'migrationHashes', pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'version', '20260817133902',
      'sha256', '331ee2d9282142ab7134f179a9b7d8b93ce64027ad6d909c0a183a2874a64d2b'
    ),
    pg_catalog.jsonb_build_object(
      'version', '20260821223849',
      'sha256', '0e2981089cf0a0d32de2c5a147cc59603269e27be37eb59a4574e677a4aae0f0'
    ),
    pg_catalog.jsonb_build_object(
      'version', '20260821223851',
      'sha256', '18130f708bff981e7eb8ce5100baa0031ed89904c89918f47a9cc6ce94c8ec09'
    ),
    pg_catalog.jsonb_build_object(
      'version', '20260822213330',
      'sha256', '65acdfaff16524eda49f15544989662b52c9dba44e4fd18ba538ca2052d1dc86'
    )
  ),
  'productionContinuity', pg_catalog.jsonb_build_object(
    'ovd373Prefix', pg_catalog.jsonb_build_object(
      'count', ovd373_prefix.migration_count,
      'head', ovd373_prefix.migration_head,
      'fingerprint', ovd373_prefix.migration_fingerprint
    ),
    'ovd373OriginalSubset', pg_catalog.jsonb_build_object(
      'count', ovd373_original_subset.migration_count,
      'fingerprint', ovd373_original_subset.migration_fingerprint
    ),
    'row100', pg_catalog.jsonb_build_object(
      'version', row_100.migration_version,
      'statementHash', row_100.statement_hash
    )
  ),
  'baselineCount', baseline.migration_count,
  'baselineHead', baseline.migration_head,
  'baselineFingerprint', baseline.migration_fingerprint,
  'packageVersions', (
    select coalesce(
      pg_catalog.jsonb_agg(version::text order by version::text),
      '[]'::jsonb
    )
    from supabase_migrations.schema_migrations
    where version::text = any (array[
      '20260817133902',
      '20260821223849',
      '20260821223851',
      '20260822213330'
    ])
  ),
  'unexpectedVersionCount', (
    select pg_catalog.count(*)
    from supabase_migrations.schema_migrations
    where version::text > '20260817054500'
      and version::text <> all (array[
        '20260817133902',
        '20260821223849',
        '20260821223851',
        '20260822213330'
      ])
  ),
  'ledgerCount', ledger.migration_count,
  'ledgerHead', ledger.migration_head,
  'ledgerFingerprint', ledger.migration_fingerprint,
  'packageStatementHashes', suffix.statement_hashes,
  'rollout_control_count',
    (select pg_catalog.count(*) from private.commercial_rollout_controls),
  'enabled_rollout_control_count',
    (select pg_catalog.count(*) from private.commercial_rollout_controls where enabled),
  'active_work_queue_count',
    (select pg_catalog.count(*) from public.work_queue where status::text = any (array['queued', 'running']::text[])),
  'active_quote_request_count',
    (select pg_catalog.count(*) from public.quote_requests where status::text = any (array['queued', 'requesting']::text[])),
  'active_quote_run_count',
    (select pg_catalog.count(*) from public.quote_runs where status::text = any (array['queued', 'running']::text[])),
  'active_vendor_quote_result_count',
    (select pg_catalog.count(*) from public.vendor_quote_results where status::text = any (array['queued', 'running']::text[])),
  'total_vendor_quote_offers',
    (select pg_catalog.count(*) from public.vendor_quote_offers)
  ) as ovd418_production_preconditions
from ovd373_prefix -- NOSONAR: every aggregate CTE is guaranteed to return exactly one row; the join count cannot multiply evidence.
cross join ovd373_original_subset -- NOSONAR: each aggregate CTE is guaranteed to return exactly one row.
cross join row_100 -- NOSONAR: each aggregate CTE is guaranteed to return exactly one row.
cross join baseline -- NOSONAR: each aggregate CTE is guaranteed to return exactly one row.
cross join ledger -- NOSONAR: each aggregate CTE is guaranteed to return exactly one row.
cross join suffix; -- NOSONAR: each aggregate CTE is guaranteed to return exactly one row.

commit;
