# Staging seed fixtures (OVD-837)

Synthetic, PII-free fixtures for the **staging** Supabase project
(`ldmambwtksfvqdufhaam`) only. Never apply them to production
(`ozuatdcakezjtevztjlr`) or any other project. Nothing here is a migration,
and `supabase db reset` does not load these files.

| File | Purpose |
| --- | --- |
| `staging.sql` | The seed. One statement batch with no `begin`/`commit` and no psql meta-commands, so the Supabase SQL API (MCP `execute_sql`) can run it as one transaction. |
| `staging-counts.sql` | Read only. Total and fixture row counts per seeded table, including the rows insert triggers derive. |
| `staging-smoke.sql` | Read only. The OVD-813 sanity-gate history read (`worker/src/fixtureHeal/sanityHistory.ts`) as SQL, `limit 50`. Expect more than 0 rows (4 with the current seed). |

## What it seeds

All ids start with `83700000-5eed-`. The seed rows carry `stagingFixture: "ovd-837"`
(user metadata, job `source = 'staging_fixture'`, spec snapshots and `raw_payload`).

- `auth.users`: 3 users at `@example.test` with made-up names and no password,
  so none of them can sign in. No `auth.identities` rows: nothing requires them.
- `public.organizations` (2), `public.organization_memberships` (3),
  `public.jobs` (3), `public.organization_file_blobs` (4), `public.job_files` (4),
  `public.parts` (3), `public.approved_part_requirements` (3),
  `public.quote_requests` (4), `public.quote_runs` (4).
- `public.vendor_quote_results` (9): 8 carry `raw_payload.fixtureSanity`
  (`packageId`, `requirementKey`, `cheapestUnitUsd`, v2 verdict). This includes one held
  (`manual_review_pending`) row. One pre-gate `failed` row has no `fixtureSanity`.
- `private.provider_kill_switches` (one per `vendor_name`) and
  `private.provider_global_kill_switch`: a missing row is recreated **engaged**
  (fail closed). An existing switch is never touched, engaged or released.
- Written by insert triggers, first run only: `public.canonical_parts`,
  `public.part_versions`, `private.part_fingerprint_observations`,
  `private.part_deadline_history`, `private.sourcing_destination_history`.

File paths such as `staging-fixtures/ovd837/alpha/fixture-bracket-a.step` are
synthetic. No storage object is uploaded, and the hashes are sha256 of fixed labels.

## Idempotency

Every insert uses fixed ids and `on conflict do nothing`, so a second run inserts
nothing and every count in `staging-counts.sql` stays the same. The one update:
a fixture result whose `created_at` is older than 60 days is moved back inside
the window. Without it, the 90-day history read would stop finding it.

## Running it

Runner (psql required). psql is resolved to an absolute path: `PSQL_BIN` if set
(it must be absolute), otherwise the first `psql` in a fixed list of directories
(`/usr/bin`, `/usr/local/bin`, `/bin`, `/opt/homebrew/bin`, Homebrew libpq). The
inherited `PATH` is never used. The database URL is split into libpq variables
and never printed:

```sh
# Guard only: exits 1 for production, an unknown ref, or refs that disagree.
node scripts/seed-staging.mjs --ref ldmambwtksfvqdufhaam --check-target

# counts -> seed (single transaction) -> counts -> smoke
STAGING_DATABASE_URL='<staging connection string>' node scripts/seed-staging.mjs

# Read-only checks
STAGING_DATABASE_URL='<staging connection string>' node scripts/seed-staging.mjs --counts
STAGING_DATABASE_URL='<staging connection string>' node scripts/seed-staging.mjs --smoke
```

The runner uses an allowlist. `--ref`, `SUPABASE_URL` and `STAGING_DATABASE_URL`
(host `db.<ref>.supabase.co` or pooler user `postgres.<ref>`) must all name exactly
`ldmambwtksfvqdufhaam`. It exits non-zero before starting psql when any of these holds:

- a source names production;
- the sources disagree;
- a ref cannot be derived;
- no target is given.

In-SQL guard: `staging.sql` starts with a `do` block that raises an exception,
before any write, unless the transaction-local setting `ovd837.seed_target_ref`
is `ldmambwtksfvqdufhaam`. A Supabase database does not expose its own project
ref, so the caller that already proved the target asserts it: the runner sets it
with `set local` inside the seed's single transaction. Pasting the file alone
anywhere writes nothing.

Supabase MCP: first run the `--check-target` command above. Then pass `project_id`
`ldmambwtksfvqdufhaam` to `execute_sql`, and run `staging.sql` as one call,
prefixed with
`select set_config('ovd837.seed_target_ref', 'ldmambwtksfvqdufhaam', true);`.
Run `staging-counts.sql` before and after, and run the seed twice to confirm
the counts match. Finish with `staging-smoke.sql`.

Guard test: `npx vitest run --maxWorkers=2 scripts/seed-staging.test.mjs`. It needs no network.
