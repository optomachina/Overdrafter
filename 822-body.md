## OVD-879: DB-side staging sentinel

Implements the Architect design on OVD-879. This adds to the OVD-837 ref guard and the OVD-839 URL guard; it does not replace them.

- `supabase/staging/bootstrap-marker.sql` is the only file that creates the marker. It creates `overdrafter.environment_marker(env text primary key check (env='staging'), created_at)`, inserts `staging` idempotently, enables RLS with no policies, and revokes access from public, anon and authenticated. Run it once on staging only, after the target guard.
- The first statement of `supabase/seed/staging.sql` (same transaction, before any write) raises `STAGING_SENTINEL_MISSING` unless `to_regclass(...)` is non-null and the `env='staging'` row exists. The seed never creates or writes the marker.
- `scripts/staging-sentinel.test.mjs` contains the static tests: the sentinel comes first, the seed never touches the marker, migrations never mention it, and the bootstrap has the CHECK, RLS and revokes.
- `scripts/local-pg17-sentinel-proof.sh` runs the six-case proof on a throwaway local PG17 cluster on a unix socket (no TCP).
- No files under `supabase/migrations/`, no new dependencies, no workflow changes. Hosted staging and prod were not touched.

## Local PG17 proof (six cases, at this head)

```
cluster: PostgreSQL 17.11 (Debian 17.11-0+deb13u1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
cluster: unix socket /tmp/tmp.bXXzq9RyZi port 54879, listen_addresses='' (disposable, deleted on exit)
setup: applied 153 migrations from supabase/migrations

== case 1: no overdrafter schema
overdrafter schema present: false
  seed exit 3: psql:/workspace/wt-879/supabase/seed/staging.sql:44: ERROR:  STAGING_SENTINEL_MISSING: overdrafter.environment_marker has no staging row; run supabase/staging/bootstrap-marker.sql once on staging first (OVD-879)
  user tables snapshotted: 136, rows: 82 before, 82 after
  attempted row writes (pg_stat_user_tables): 82 before, 82 after
PASS case 1: seed raised STAGING_SENTINEL_MISSING
PASS case 1: every user table row count identical before/after
PASS case 1: zero row writes attempted

== case 2: schema and table, no marker row
marker rows: 0
  seed exit 3: psql:/workspace/wt-879/supabase/seed/staging.sql:44: ERROR:  STAGING_SENTINEL_MISSING: overdrafter.environment_marker has no staging row; run supabase/staging/bootstrap-marker.sql once on staging first (OVD-879)
  user tables snapshotted: 137, rows: 82 before, 82 after
  attempted row writes (pg_stat_user_tables): 82 before, 82 after
PASS case 2: seed raised STAGING_SENTINEL_MISSING
PASS case 2: every user table row count identical before/after
PASS case 2: zero row writes attempted
NOTICE:  drop cascades to table overdrafter.environment_marker

== case 3: bootstrap, then seed twice
psql:/workspace/wt-879/supabase/staging/bootstrap-marker.sql:18: NOTICE:  schema "overdrafter" already exists, skipping
psql:/workspace/wt-879/supabase/staging/bootstrap-marker.sql:23: NOTICE:  relation "environment_marker" already exists, skipping
marker rows after two bootstraps: staging (1)
  seed run 1 exit 0
  attempted row writes (pg_stat_user_tables): 83 before, 154 after
  staging-counts.sql after run 1 (table | total | fixture):
    auth.users | 3 | 3
    public.organizations | 2 | 2
    public.organization_memberships | 3 | 3
    public.jobs | 3 | 3
    public.organization_file_blobs | 4 | 4
    public.job_files | 4 | 4
    public.parts | 3 | 3
    public.approved_part_requirements | 3 | 3
    public.quote_requests | 4 | 4
    public.quote_runs | 4 | 4
    public.vendor_quote_results | 9 | 9
    vendor_quote_results with fixtureSanity | 8 | 8
    private.provider_kill_switches | 18 | 18
    private.provider_kill_switches engaged | 0 | 0
    private.provider_global_kill_switch | 1 | 1
    public.canonical_parts (trigger) | 3 | 3
    public.part_versions (trigger) | 3 | 3
    private.part_fingerprint_observations (trigger) | 3 | 3
    private.part_deadline_history (trigger) | 3 | 3
    private.sourcing_destination_history (trigger) | 2 | 2
PASS case 3: seed succeeded after bootstrap
PASS case 3: write counter control: the seed's writes are visible (71 rows)
PASS case 3: seeded counts match the expected fixture counts (18 kill switches)
PASS case 3: every trigger-derived table has fixture rows
  seed run 2 exit 0
PASS case 3: second seed run idempotent (staging-counts.sql identical)
PASS case 3: second seed run left every user table row count identical (137 tables)

== case 4: env = 'prod' violates the CHECK
  ERROR:  new row for relation "environment_marker" violates check constraint "environment_marker_env_check"
DETAIL:  Failing row contains (prod, 2026-10-16 12:37:44.189801-07).
PASS case 4: insert env='prod' rejected by environment_marker_env_check
marker rows: staging

== case 5: API roles cannot read the marker
rls enabled: true, policies: 0
  anon: ERROR:  permission denied for schema overdrafter
LINE 1: select env from overdrafter.environment_marker
                        ^
PASS case 5: select as anon denied
  anon with schema usage: ERROR:  permission denied for table environment_marker
PASS case 5: select as anon denied by the table revoke even with schema usage
  authenticated: ERROR:  permission denied for schema overdrafter
LINE 1: select env from overdrafter.environment_marker
                        ^
PASS case 5: select as authenticated denied
  authenticated with schema usage: ERROR:  permission denied for table environment_marker
PASS case 5: select as authenticated denied by the table revoke even with schema usage
PASS case 5: temporary schema usage grants rolled back

== case 6: static tests
 ✓ scripts/staging-sentinel.test.mjs (7 tests) 100ms
 ✓ scripts/seed-staging.test.mjs (23 tests) 699ms
 Test Files  2 passed (2)
      Tests  30 passed (30)
PASS case 6: static tests

RESULT: PASS (all six cases)
cleanup: cluster stopped and /tmp/tmp.bXXzq9RyZi deleted
```
