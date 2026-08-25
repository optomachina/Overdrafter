-- OVD-418 hosted production pre-release verification.
--
-- Read-only by construction. This script inspects only the migration ledger,
-- the four commercial rollout controls, active-work aggregates, and the total
-- vendor-offer count used by the release runner for before/after comparison.
-- It emits no customer or provider row identity or content.

begin read only;

do $ovd418_preconditions$
declare
  v_count bigint;
  v_enabled_count bigint;
  v_expected_count bigint;
begin
  -- Ledger classification is intentionally deferred to the release runner.
  -- This gate must remain usable from exact baseline, partial-one recovery,
  -- and already-final states while still refusing unsafe operational state.
  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where enabled),
    pg_catalog.count(*) filter (where capability = any (array[
      'automatic_quote_collection',
      'commercial_admin_mutations',
      'order_administration',
      'promotion_codes'
    ]))
  into v_count, v_enabled_count, v_expected_count
  from private.commercial_rollout_controls;

  if v_count <> 4 or v_expected_count <> 4 or v_enabled_count <> 0 then
    raise exception
      'OVD-418 rollout precondition failed: % total, % recognized, % enabled',
      v_count,
      v_expected_count,
      v_enabled_count;
  end if;

  select pg_catalog.count(*) into v_count
  from public.work_queue
  where status::text = any (array['queued', 'running']::text[]);
  if v_count <> 0 then
    raise exception
      'OVD-418 work queue is not quiescent: % queued or running tasks (including vendor work)',
      v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from public.quote_requests
  where status::text = any (array['queued', 'requesting']::text[]);
  if v_count <> 0 then
    raise exception
      'OVD-418 quote requests are not quiescent: % queued or requesting requests',
      v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from public.quote_runs
  where status::text = any (array['queued', 'running']::text[]);
  if v_count <> 0 then
    raise exception
      'OVD-418 quote runs are not quiescent: % queued or running runs',
      v_count;
  end if;

  select pg_catalog.count(*) into v_count
  from public.vendor_quote_results
  where status::text = any (array['queued', 'running']::text[]);
  if v_count <> 0 then
    raise exception
      'OVD-418 vendor quote results are not quiescent: % queued or running results',
      v_count;
  end if;
end;
$ovd418_preconditions$;

with baseline as (
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
from baseline
cross join ledger;

commit;
