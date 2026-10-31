# OVD-979 U2: canonical requirement lock order

Scope: redesign unit U2 replacing the lock-order portion of draft PR #874.
Blaine's staff-path decision permits this change. This unit changes no attempt
identity, provenance/ownership policy, backfill, extraction scheduling, or the
one-hour deferred-task backstop. No hosted database was contacted.

## Files and application

- `supabase/migrations/20261031034700_ovd979u2_canonical_requirement_lock_order.sql` is the only forward copy.
- The rollback is generated, not stored: `node scripts/ovd979-rollback.mjs
  20261031034700_ovd979u2_canonical_requirement_lock_order.sql` prints each
  replaced function's previous `CREATE` statement, cut byte for byte from the
  latest earlier migration that defines it, followed by the migration's own
  revoke/grant lines. A stored copy duplicated about 700 lines of the migration
  (Sonar duplication gate), so it was deleted. Neither the migration nor the
  generated rollback wraps a transaction; apply each in one transaction. Both
  support repeat application.
- The rollback never restores a `public`-first `search_path`. A prior path that
  does not start with `pg_catalog` is emitted as `pg_catalog, <prior path>`, so
  `lint-security-definer` would accept it as a forward migration and no
  baseline growth is needed. `prosrc`, which the md5 proof compares, is
  unchanged by this.
- No tables, columns, indexes, RLS policies, owners, or grant recipients change.
  Forward functions pin `search_path = pg_catalog, public`, revoke PUBLIC/anon,
  and retain authenticated/service_role for staff approval and reset, and
  service_role only for auto approval and trusted reuse.
- `function-supersessions.json` needs no new entry. The collision check passes
  without an exception.
- `scripts/free-quote-ci-profile.mjs` and `scripts/fixtures/free-quote-ci-source.json`
  (infra_ci) pin this migration's sha256 as a reviewed append. Any change to the
  migration must re-pin both; this round re-pinned them to
  `572066174ddb087f2c20149759f339be12e6408bc3d44ca4e3eb8dadbb59906f`.

## Implementation and review

All five paths acquire the job's `FOR NO KEY UPDATE` lock before lower levels,
and every L2, L3 and L4 prelock is `FOR NO KEY UPDATE`. `FOR UPDATE` would
conflict with the KEY SHARE that a `work_queue` insert takes on `parts` through
its foreign key. `api_request_extraction` now locks L1 before
`api_reconcile_job_parts` and its queue insert, so approval can no longer hold
L1 while waiting on parts that request holds. Its trailing `jobs` update
re-locks a row it already holds, so the listed `work_queue > jobs` pair never
waits; Redesign PR 5 removes the pair.
Staff approval and auto approval prelock parts in `id` order, requirements in
`part_id` order, then extractions in `part_id` order. Reset touches one part.
Reuse reads the target job ID without locking, locks that job, then locks and
rereads the target with the same job predicate; its source remains read-only.
No writer moves a part to another job, so the unlocked read stays valid; a
concurrent delete fails the lineage check (code comment in the migration).
Reuse keeps its prior `search_path = pg_catalog`: every reference is
schema-qualified, so widening it was unnecessary.
Reset retains its existing permission check and reloads the context after the
job lock, so waiting does not retain the pre-wait context.

The static checker treats later writes as lock steps even when prelocked.
Its logic is unchanged: only the three resolved functions' expected inversion
entries are removed. Accordingly, writes use separate L1/L2/L3/L4 phases.
Staff approval retains input order within its quantity/requirement phases,
including duplicate-part last-input-wins behavior and the original count.
Auto approval stages the existing computed values in typed in-memory arrays,
then writes them in level order. Its pre-write unapproved count excludes its
own staged requirement inserts, matching the original post-insert count.
All field calculations, review blockers, pending/failed task predicates, status
choices, and audit payloads remain the previous implementation's decisions.
Arrays consume memory proportional to this job's part count.

The SQL files exceed the normal line guideline because `CREATE OR REPLACE`
and byte-exact rollback must each include four complete existing bodies. The
semantic delta is lock acquisition and write phasing for one shared lock graph;
there is no independent feature or unrelated schema change to split out.

## Prior bodies and rollback

| Function | Previous migration | `md5(prosrc)` restored |
| --- | --- | --- |
| `api_approve_job_requirements(uuid,jsonb)` | `20260316170500` | `36f04967deda1fa9958e511c6ec54c43` |
| `api_request_extraction(uuid)` | `20260812042000` | `7b2804b18559df073dcd4651e80b3ce6` |
| `api_auto_approve_job_requirements(uuid)` | `20260317013000` | `f3f917a04cb239c9ce25063c5bcec91b` |
| `api_reset_client_part_property_overrides(uuid,text[])` | `20260408120000` | `bc843ab5b5285afa764a1578e68da8b0` |
| `api_reuse_trusted_part_version_artifacts(uuid,uuid,uuid)` | `20260812042000` | `2a6f670d20b0123b9e0507d1fef2f8f0` |

The committed proof is `node scripts/ovd979-rollback.mjs
20261031034700_ovd979u2_canonical_requirement_lock_order.sql --prove --db-url
<loopback URL>` against a local database with the migration applied. It runs in
one transaction that always rolls back. Output on the round-1 fixture
(2026-10-30, migration sha256 `572066174ddb…906f`, recorded under the pre-rename
filename `20261030162500_…`; the bytes are unchanged):

```
applied migration differs from the prior bodies: PASS
rollback restores md5(prosrc) of 5 prior bodies, path pg_catalog first: PASS
rollback keeps the applied ACLs: PASS
second rollback is a no-op: PASS
re-apply restores the applied bodies, ACLs and config: PASS
ovd979 rollback proof: PASS (20261030162500_ovd979u2_canonical_requirement_lock_order.sql)
```

`scripts/ovd979u2-migration.test.mjs` runs in CI without a database. It checks
that the generated rollback restores each prior body byte for byte from the
named source migration and never emits a non-`pg_catalog`-first path.
The `ephemeral-db` rollback stage replays only `.rollback.sql` files whose stem
matches a forward draft. U2 has had no forward draft since the duplicate copy
was dropped, so that stage never ran U2's rollback; the proof above replaces it.
Rollback and forward do not rewrite application data.

## Local verification (2026-10-30 UTC)

Owner: OVD-979 U2, `/workspace/ovd979-u2`, branch
`fix/ovd979-u2-lock-order`, base `b620262244aaab65f86bea813da36f48aef70ac3`.
The database is an exclusively owned disposable Docker fixture using cached
`supabase/postgres:17.6.1.095`, an internal network with no published ports,
read-only root, tmpfs data, 1 CPU, 1 GiB memory and 256 PIDs. All repository
migrations were replayed. The platform prerequisite shim comes from the
maintained `scripts/local-pg17-sentinel-proof.sh`; GoTrue/HTTP are outside this
SQL-only proof. Existing local stacks and both forbidden hosted projects were
untouched.

- `node scripts/check-lock-order.mjs`: PASS; these three functions have zero
  inversions, reuse starts at L1; the expected U5 request inversion remains.
- `node scripts/lint-security-definer.mjs --enforce`: PASS, zero new violations
  or baseline additions.
- `node scripts/check-migration-function-collisions.mjs`: PASS.
- `vitest run scripts/check-lock-order.test.mjs scripts/ovd979u2-migration.test.mjs src/features/quotes/auto-approve-migration.test.ts`:
  PASS, 35 artifact, checker and existing auto-approval regression tests.
- `supabase/tests/ovd979u2_lock_order.sql`: PASS, 45 assertions (53 after
  repair round 1, below). Real dblink
  transactions exercise approve/request, approve/auto, approve/reset and
  reuse/request in both holder/waiter directions with 5-second lock timeouts;
  the observer checks an ungranted `pg_locks` row and the actual blocking PID.
  Four additional probes hold L1 while each changed RPC waits, and demonstrate
  that the holder can still lock all L2/L3/L4 rows. Both transactions roll back;
  committed fixture rows and helpers are removed at completion.
- Prior-body negative control: applying the rollback makes six assertions fail,
  including the lower-level lock probes for approve/auto/reset and the L1 probe
  for reuse. Reapplying the forward makes all 45 pass again.
- `supabase/tests/canonical_part_identity.sql`: PASS, 13 existing reuse and
  lineage assertions.
- Local differential driver: PASS, 40 assertions over 20 scenarios. The forward
  and prior bodies return identical values and application/audit projections
  for all ten job statuses, pending/failed work, missing requirements, review
  blockers, unknown material, no extraction evidence, duplicate staff inputs,
  reset with/without a requirement, and reuse. Only generated row identities
  and deadline-history wall-clock timestamps are normalized. Each comparison
  runs against the same fixture and transaction timestamp using savepoints.

Round 0 kept its runner inputs in an uncommitted `/tmp/ovd979-u2-proof/`
directory, which no longer exists. The md5 roundtrip is now committed as the
generator's `--prove` mode above. The 20-scenario equivalence driver was not
recovered; its result above is round-0 evidence only and is not reproducible
from this repository.

## Limits and remaining work

- Auto approval reads requirements and extractions without locks and writes
  them later in its phases. Writers that skip L1, such as the worker extraction
  write, can still race in that window, which the L1 hold makes longer. This is
  a known gap; U4's attempt-id gate is the planned cover.
- The plan's section 3 lists `load_editable_project_part_context` as L1-first.
  It is unchanged: it is a `stable` read, and reset now takes L1 after calling
  it and reloads the context. The plan item is resolved that way.
- The auto-approve rewrite belongs to U4 in the plan. It lands here because the
  unchanged lock-order checker required phased writes; U4 must keep them.
- The worker extraction write path is outside SQL and is not covered by these
  pgTAP waits. Debug and
manual quote audits are in `docs/ovd979-lock-order.md`. Exact-head independent
migration review and hosted gates remain integration work; no commit, push,
PR operation, hosted apply or production action is part of this worktree task.

## Repair round 1 (2026-10-30)

- `api_request_extraction` joins the migration and takes L1 first; all L2, L3
  and L4 prelocks, including reuse's target part, use `FOR NO KEY UPDATE`.
- `supabase/tests/ovd979u2_lock_order.sql` gains a mid-function interleaving
  test (53 assertions). On the round-0 bodies the two interleave cases fail
  with `40P01: deadlock detected`; with this migration all 53 pass (three
  consecutive runs on the fixture; one earlier run right after a DB restart
  hit a 10s statement timeout and was not reproducible).
- The dblink fallback no longer carries a credential. The test creates a
  login role with a random password generated in the run and drops it at the
  end; `ovd.test_conninfo` still selects host, port and database.
- The stored rollback and both duplicate draft copies are gone; the rollback is
  generated and proven as described above.

## Re-timestamp (2026-10-31)

Main gained `20261030204050_ovd1018_restrict_project_jobs_writes.sql`, so the
U2 file sorted before main's newest migration and
`verify-migration-lineage --against-base` failed. The file is renamed
`20261030162500_…` → `20261031034700_ovd979u2_canonical_requirement_lock_order.sql`.
This is a rename only: the bytes and SHA-256 (`572066174ddb…906f`) are
unchanged, so the rollback proof above, recorded under the old filename, still
covers this content. The stack order stays U2 (`20261031034700`) < U3
(`20261031034754`) < U4 (`20261031034800`) < U5 (`20261031034900`).

## Repair round: SonarCloud new-code findings (2026-10-31)

The migration is untouched (sha256 `572066174ddb…906f`).

- `scripts/ovd979-rollback.mjs`: `--prove` runs psql from `findPsql()` (fixed
  system directories or `SEED_PSQL_PATH`), not a `PATH` lookup, with a fixed
  `PATH=/usr/bin:/bin` for the child (S4036). The `search_path` regex uses
  `\s*(\S.*)` so prefix and path cannot overlap (S8786); `findLast` (S7750);
  `String.raw` (S7780). The generated rollback for this migration is
  byte-identical before and after (sha256 `1415e4a8…9965`), and the old and new
  regex capture the same groups on all 554 `search_path` lines in the
  migrations.
- `supabase/tests/ovd979u2_lock_order.sql`: no newline inside a literal (the
  approval payload is built with `jsonb_build_array`/`jsonb_build_object`);
  repeated UUIDs, session names, transaction settings, the wait loop, the
  result read and the cleanup moved into constants and `pg_temp` helpers.
- Local proof on a disposable PostgreSQL 16.15 cluster (unix socket only,
  `scripts/window-1/supabase-shim.sql`, all 163 migrations, pgTAP and dblink
  from distribution packages): the old and new suites both pass 53/53 with U2
  applied. With U2 rolled back to the prior bodies, both fail the same 5
  assertions (48/53). After re-apply the new suite passes 53/53 again.
  `ovd979-rollback.mjs --prove`: PASS. No hosted database was contacted.

## Status (OVD-979 U6)

Retired. Repair round 1 deleted the forward draft copy and the stored rollback
instead of adding a `SUPERSEDED` header: the copies duplicated the promoted
migration (Sonar duplication gate), and with no copy left nothing can replay
this unit's bodies over a later unit's, so the function-collision check passes
on every PR in the stack without a header or a `function-supersessions.json`
entry. The rollback is generated by `scripts/ovd979-rollback.mjs`.
`scripts/ovd979-drafts-retired.test.mjs` keeps it that way: it fails if a
forward or rollback copy of U2–U5 reappears, if any `ovd-979*.rollback.sql`
file appears in the drafts folder under any name, or if any `ovd-979*` draft
defines a function without a `SUPERSEDED` header. No `function-supersessions.json`
entry is added for U3's `api_claim_next_task` either: no draft body is left to
supersede the deployed one. This section also covers U3.
