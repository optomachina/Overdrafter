# Staging Supabase runbook

Last verified: October 16, 2026

This runbook covers the hosted staging database and the staging-first migration
flow (OVD-839). It does not authorize any production change. Production
database changes still follow `AGENTS.md` protected actions and the applicable
release runbook, and they still need Blaine's approval card.

## Project

| Field | Value |
| --- | --- |
| Name | `overdrafter-staging` (provisioned in OVD-836) |
| Project ref | `ldmambwtksfvqdufhaam` |
| Region | `us-west-1` |
| Plan | Supabase Free: pauses when idle, no managed backups, no branching |
| Production ref (never a staging target) | `ozuatdcakezjtevztjlr` |

Who may use it: agents and Blaine. Staging writes are allowed (migrations,
rollbacks, reset, reseed, smoke reads) without an approval card. Staging holds
**synthetic data only**. Never copy production rows, Auth users, Storage
objects, provider credentials, or customer files into staging, and never point
a live provider worker at it.

State at last verification: all 153 migrations in `supabase/migrations` on
`main` were replayed to the fresh project on 2026-10-16 through Supabase MCP
`execute_sql`, and `supabase_migrations.schema_migrations` holds a history row
for each, so `list_migrations` reports all 153. See
[execute_sql caveats](#execute_sql-caveats) for how that replay was batched.

## Double-check the ref before every DB command

Before every command that touches a hosted database (MCP `execute_sql`,
`apply_migration`, `list_migrations`, `psql`, `supabase db push`,
`supabase link`, seed or reset), read the target ref back and confirm it is
`ldmambwtksfvqdufhaam`. Do this per command, not per session: MCP calls take
`project_id` on every call, and a linked CLI project survives across shells.

```bash
# Exits non-zero for the production ref or any ref other than staging.
node scripts/staging-reset-guard.mjs ldmambwtksfvqdufhaam
# A connection URL works too if it matches the allowlist below (it must end in
# ?sslmode=require or ?sslmode=verify-full); only the ref is printed, never the
# password. Unset the ten PG* variables listed under "Prod-ref guard" first or
# the guard refuses.
node scripts/staging-reset-guard.mjs \
  "postgresql://postgres:<password>@db.ldmambwtksfvqdufhaam.supabase.co:5432/postgres?sslmode=require"
node scripts/staging-reset-guard.mjs "$STAGING_DB_URL"
# Confirm what the CLI is linked to before db push.
cat supabase/.temp/project-ref
```

If the ref you read back is `ozuatdcakezjtevztjlr`, or anything you cannot
match to the table above, stop. Do not retry against a guessed ref.

## Prod-ref guard

[`scripts/staging-reset-guard.mjs`](../../scripts/staging-reset-guard.mjs)
exports `assertStagingRef(ref)`, `assertStagingTarget(refOrUrl)` and
`assertStagingConnectionEnv(env)`. The ref allowlist is exactly
`ldmambwtksfvqdufhaam`; the production ref, unknown refs and malformed refs are
refused. It makes no network or database call. Exit code 0 accepts, 1 refuses,
2 is a usage error. Tests: `scripts/staging-reset-guard.test.mjs`.

A connection URL is accepted only if the whole string matches one anchored
pattern. There is no `URL()` parsing and no denylist: Node's URL parser and
libpq disagree on the host when `#` or `?` comes before the last `@`, so only
an exact allowlist is safe.

```text
postgres[ql]://<user>:<password>@<host>:<port>/postgres?sslmode=<require|verify-full>
```

| Part | Allowed |
| --- | --- |
| Scheme | `postgres://` or `postgresql://` (lowercase) |
| Host + user | `db.ldmambwtksfvqdufhaam.supabase.co` with user `postgres` (direct), or `aws-0-us-west-1.pooler.supabase.com` with user `postgres.ldmambwtksfvqdufhaam` (us-west-1 Supavisor pooler) |
| Port | `5432` or `6543`, always explicit |
| Password | Required, non-empty. Only `A-Z a-z 0-9 . _ ~ -` and `%XX` escapes. Percent-encode every other character (`@` → `%40`, `#` → `%23`, `?` → `%3F`, `/` → `%2F`, `:` → `%3A`, `%` → `%25`) |
| Database | `postgres` |
| Query | Required, exactly `?sslmode=require` or `?sslmode=verify-full`. No query (libpq would default to `prefer`), `sslmode=disable` / `allow` / `prefer` / `verify-ca`, or any other parameter (`options=`, `host=`, `hostaddr=`, `service=`, `target_session_attrs=`, `application_name=`, …), alone or alongside `sslmode`, is refused |

Everything else is refused: API URLs, key=value DSNs, fragments, IPv6 or
bracketed hosts, multi-host lists, other hosts (including `aws-1-` poolers),
other users or ports, uppercase hosts, and surrounding whitespace. Error
messages never print the URL, so a password is never echoed.

Accepted examples:

```text
postgresql://postgres:<password>@db.ldmambwtksfvqdufhaam.supabase.co:5432/postgres?sslmode=require
postgresql://postgres.ldmambwtksfvqdufhaam:<password>@aws-0-us-west-1.pooler.supabase.com:6543/postgres?sslmode=require
```

Pooler host: the allowlist holds only `aws-0-us-west-1.pooler.supabase.com`.
`aws-1-us-west-1.pooler.supabase.com` is refused: it is the host the prod-only
ovd373 access tool uses, so it is most likely the production cluster. Evidence
(posted on OVD-880): a credential-free TLS startup probe as
`postgres.ldmambwtksfvqdufhaam` got a SASL auth request from `aws-0-us-west-1`
(the tenant exists there) and "tenant/user not found" from `aws-1-us-west-1`.
`scripts/seed-staging.test.mjs` already uses `aws-0` for staging. Blaine can
confirm the host read-only in the staging project's Supabase dashboard
**Connect** panel. If that panel shows a different host, change the allowlist
in `scripts/staging-reset-guard.mjs` to that exact value; do not widen it to
other `aws-N-` hosts.

Pass the connection only as that validated URL. The CLI refuses to run if any
of these ten variables is set (even to an empty string), because libpq would
use them to connect somewhere or as someone other than the URL says, or with
weaker TLS or altered session settings:

`PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGSERVICE`, `PGSERVICEFILE`, `PGPASSFILE`,
`PGSSLMODE`, `PGOPTIONS`, `PGSSLROOTCERT`, `PGTARGETSESSIONATTRS`.

Unset them before running the guard and the command that follows it:

```bash
unset PGHOST PGHOSTADDR PGPORT PGSERVICE PGSERVICEFILE PGPASSFILE \
  PGSSLMODE PGOPTIONS PGSSLROOTCERT PGTARGETSESSIONATTRS
```

Rule: the staging seed (`scripts/seed-staging.mjs --check-target`, OVD-837) and
any staging reset or smoke script must run this check (or the equivalent
allowlist) on the exact ref or URL it is about to connect with, and exit
non-zero before any SQL runs if the check fails.

## Unpause (Free plan)

Free projects pause after a period of inactivity. A paused project refuses
connections; `get_project` reports a status other than `ACTIVE_HEALTHY`.

1. Supabase MCP `get_project` with `id: ldmambwtksfvqdufhaam`; confirm the
   name is `overdrafter-staging` and read the status.
2. If paused: MCP `restore_project` with `project_id: ldmambwtksfvqdufhaam`,
   or the dashboard **Restore project** button for that ref.
3. Poll `get_project` until `ACTIVE_HEALTHY`, then run
   `list_migrations` and confirm the head matches `main` before doing anything
   else. A long-paused project may need re-applying migrations merged since.

Never call `pause_project` or `restore_project` with any other ref.

## Reset and reseed

There are no backups on Free. Recovery is drop/recreate or reseed, never a
restore from production.

Reseed (synthetic fixtures from OVD-837, on `main` under `supabase/seed/`):

```bash
node scripts/staging-reset-guard.mjs "$STAGING_DB_URL"   # must print the staging ref
# seed-staging.mjs reads STAGING_DATABASE_URL, not STAGING_DB_URL.
STAGING_DATABASE_URL="$STAGING_DB_URL" node scripts/seed-staging.mjs --check-target   # refuses prod / unknown refs
STAGING_DATABASE_URL="$STAGING_DB_URL" node scripts/seed-staging.mjs                  # applies supabase/seed/staging.sql
psql "$STAGING_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/seed/staging-counts.sql
psql "$STAGING_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/seed/staging-smoke.sql
```

Full reset (schema drifted, a rollback left debris, or a drill went wrong):

1. Guard the ref (above).
2. Either delete and recreate the project as `overdrafter-staging` in
   `us-west-1` (the ref changes: update this runbook and the guard allowlist in
   the same PR), or drop and recreate the app schemas on the existing project
   and replay `supabase/migrations` in order with `supabase db push --linked`
   (not MCP `apply_migration`; see the migration flow and caveats below).
3. Confirm `list_migrations` shows every file on `main`.
4. Reseed and run the counts and smoke files.

## Read-only smoke reads

Smoke reads are `SELECT` only, always with a `LIMIT`, and never mutate. Run
them through Supabase MCP `execute_sql` with `project_id: ldmambwtksfvqdufhaam`,
or `psql` against the staging connection string after the guard passes:

```sql
select version, name
from supabase_migrations.schema_migrations
order by version desc
limit 5;
```

**Release smoke reads run on staging by default.** That includes release and
PR verification queries such as the OVD-813 sanity-history query from PR #782.
Running a smoke read on production needs Blaine's explicit approval for that
query, even when it is read-only.

### OVD-835 acceptance read

OVD-835 closes when the OVD-813 history SELECT runs on staging without error.
That read is [`supabase/seed/staging-smoke.sql`](../../supabase/seed/staging-smoke.sql)
(SELECT only, `LIMIT 50`). The criterion is that it runs without error; the
row count is informational. Fixture rows get their `created_at` when first
seeded, and a reseed only resets rows older than 60 days, so with no reseed in
between the count falls as the seed ages: 4 for about four weeks, 2 once the
peer rows leave the 30-day window, then 1 and 0 as the two xometry rows leave
the 90-day own-history window (around day 70 and day 88). Run it with the guarded
`psql` command under [Reset and reseed](#reset-and-reseed), or paste it into MCP
`execute_sql` with `project_id: ldmambwtksfvqdufhaam`. Record the UTC time, the
row count and the ref on OVD-835. A session without a staging credential
(`STAGING_DB_URL`) or Supabase MCP reports the gap on the PR instead and never
falls back to production.

## Staging-first migration flow

Every change under `supabase/migrations` goes to staging before production.

1. **Draft.** Author the change in `docs/migration-drafts/` with a matching
   `.rollback.sql` (see [Rollback](#rollback)). Qualify it locally or in CI
   (pending pgTAP workflow) as today.
2. **Guard.** Confirm the target is `ldmambwtksfvqdufhaam`.
3. **Apply to staging** with the Supabase CLI, which records each version from
   the `supabase/migrations` filename so staging history matches the repo:
   - `supabase link --project-ref ldmambwtksfvqdufhaam`, read back
     `supabase/.temp/project-ref`, then `supabase db push --linked`
     (or `supabase migration up --linked`). Check with
     `supabase migration list --linked` that local and remote versions match.
   - **Do not use Supabase MCP `apply_migration`.** It stamps a new
     current-timestamp version instead of the repo filename's version, so
     staging history diverges from `supabase/migrations` and a later
     `db push` sees the file as unapplied.
   - If the CLI cannot reach staging, MCP `execute_sql` is the fallback: run
     the file as written, then insert the history row with the repo filename's
     version and name (see [execute_sql caveats](#execute_sql-caveats)).
4. **Rollback drill on staging.** Apply, roll back, re-apply.
5. **Smoke reads on staging.** Run the PR's smoke SQL (SELECT + LIMIT) and
   `list_migrations`. Record pass or fail.
6. **Record** both results in the PR and the release notes with the
   [template](#evidence-template).
7. **Production apply** happens only after the staging apply **and** the
   staging smoke reads pass, and only with Blaine's approval card naming the
   commit SHA and the passing checks (`AGENTS.md`). Staging evidence does not
   replace the approval card. Production apply stays manual and follows the
   applicable release runbook; nothing here automates it.

A failed staging apply or smoke read blocks production. Fix the migration,
reset staging if needed, and restart from step 2.

### Evidence template

Paste into the PR description and the release notes. Fill every field; write
`not run` rather than leaving a field blank.

```markdown
### Staging-first migration evidence (OVD-839)

| Step | Value |
| --- | --- |
| Migration id(s) | `<14-digit timestamp>_<slug>.sql` |
| Commit SHA | `<sha>` |
| Staging ref | `ldmambwtksfvqdufhaam` (guard output: `<paste>`) |
| Staging apply | pass / fail, `<UTC timestamp>`, method: `db push --linked` / `migration up --linked` / `execute_sql` + history row |
| Staging rollback drill | apply → rollback → re-apply: pass / fail, `<UTC timestamp>` |
| Staging smoke SQL | see block below |
| Staging smoke result | pass / fail, `<UTC timestamp>`, rows: `<summary>` |
| Staging list_migrations head | `<version>` |
| Production approval card | `<link>` (Blaine) / not yet requested |
| Production apply | pass / fail / not run, `<UTC timestamp>`, ref `ozuatdcakezjtevztjlr` |
| Production smoke read | not run / approved by Blaine `<link>`: pass / fail, `<UTC timestamp>` |

Smoke SQL (SELECT only, LIMIT):

    <paste the exact SQL>
```

## Rollback

- Every migration promoted to `supabase/migrations` ships a rollback file in
  the `docs/migration-drafts/<issue>.rollback.sql` pattern: `if exists`
  throughout, replayable, and a header that states data loss.
- Test the rollback on staging before production: apply the draft, apply the
  rollback, re-apply the draft, then run the smoke reads. Record it in the
  evidence template.
- Staging recovery is drop/recreate or reseed. Never restore staging from a
  production dump, and never copy production data to repair it.
- Production rollback is a separate Blaine-approved action under the release
  runbook.

## execute_sql caveats

Supabase MCP `execute_sql` runs each call inside one transaction. The
2026-10-16 replay of all 153 migrations used these rules, and they apply to any
MCP-driven apply:

- **Batch per transaction.** Each batch of migration files is one transaction;
  a failure rolls back the whole batch, so restart from that batch.
- **`ALTER TYPE ... ADD VALUE` ends a batch.** A new enum value cannot be used
  in the transaction that adds it. End the batch after any migration that adds
  an enum value, and run later uses in the next batch.
- **`CREATE INDEX CONCURRENTLY` cannot run in a transaction.** The replay ran
  `20260324010000` without `CONCURRENTLY`. That is acceptable on staging only;
  never edit the migration file, and never drop `CONCURRENTLY` on production.
  `supabase db push` handles these files as written.
- **Record history.** MCP `execute_sql` does not write
  `supabase_migrations.schema_migrations`. Insert the history row for each
  applied file using the version and name from its `supabase/migrations`
  filename, so `list_migrations` matches the repo and a later `db push` does
  not re-apply it. Never use `apply_migration` for this: it records a new
  timestamp version that does not match the repo.

## Related

- `RUNBOOK.md` (Database section)
- `docs/workflows/ovd418-qualified-database-release.md`
- `docs/workflows/ovd361-production-deployment.md`
- `docs/supabase-migration-history-reconciliation.md`
- `docs/agent-development-control-plane.md`
