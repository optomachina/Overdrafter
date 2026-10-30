# OVD-979 U2: canonical requirement lock order

Scope: redesign unit U2 replacing the lock-order portion of draft PR #874.
Blaine's staff-path decision permits this change. This unit changes no attempt
identity, provenance/ownership policy, backfill, extraction scheduling, or the
one-hour deferred-task backstop. No hosted database was contacted.

## Files and application

- `supabase/migrations/20261030162500_ovd979u2_canonical_requirement_lock_order.sql`
  and `docs/migration-drafts/ovd-979u2.sql` are byte identical.
- `docs/migration-drafts/ovd-979u2.rollback.sql` restores the previous four
  function definitions, including their original body bytes and search paths,
  with the existing post-OVD-736/OVD-535 grants. Neither file wraps a transaction;
  apply each file in one transaction. Both support repeat application.
- No tables, columns, indexes, RLS policies, owners, or grant recipients change.
  Forward functions pin `search_path = pg_catalog, public`, revoke PUBLIC/anon,
  and retain authenticated/service_role for staff approval and reset, and
  service_role only for auto approval and trusted reuse.
- `function-supersessions.json` needs no new entry: the forward draft is already
  byte identical to its matching new migration in this change. The collision check
  passes without an exception; rollback files are excluded by its existing rule.

## Implementation and review

All four paths acquire the job's `FOR NO KEY UPDATE` lock before lower levels.
Staff approval and auto approval prelock parts in `id` order, requirements in
`part_id` order, then extractions in `part_id` order. Reset touches one part.
Reuse reads the target job ID without locking, locks that job, then locks and
rereads the target with the same job predicate; its source remains read-only.
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
| `api_auto_approve_job_requirements(uuid)` | `20260317013000` | `f3f917a04cb239c9ce25063c5bcec91b` |
| `api_reset_client_part_property_overrides(uuid,text[])` | `20260408120000` | `bc843ab5b5285afa764a1578e68da8b0` |
| `api_reuse_trusted_part_version_artifacts(uuid,uuid,uuid)` | `20260812042000` | `2a6f670d20b0123b9e0507d1fef2f8f0` |

The local roundtrip captures these four hashes, ACLs and `proconfig`, applies
forward twice, rolls back twice and compares each restoration, then reapplies.
The catalog checks pass (15 assertions). Rollback deliberately restores the
historical `public` / `pg_catalog` search paths rather than leaving the forward
configuration behind. Rollback and forward do not rewrite application data.
The Vitest artifact test also compares rollback body strings directly to the
four original migration definitions, without whitespace normalization.

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
- `supabase/tests/ovd979u2_lock_order.sql`: PASS, 45 assertions. Real dblink
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

Evidence and runner inputs are in `/tmp/ovd979-u2-proof/`: `owner.json`,
`bootstrap.sql`, `migrations.log`, `pgtap.log`, `negative-control.log`,
`pgtap-final.log`, `roundtrip.sql` / `roundtrip.log`,
`equivalence.py` / `equivalence.sql` / `equivalence.log`, and `canonical.log`.
The temporary psql adapter executes only inside this run's Docker container;
the host `pg_prove --norc -b /tmp/ovd979-u2-proof/psql -h /tmp -U postgres -d postgres`
invocations run the named SQL files copied into that container's tmpfs.

## Limits and remaining work

`api_request_extraction` and `api_reconcile_job_parts` still need U5's L1-first
change. These tests cover observed contention at the RPC boundary and the
changed functions' first-lock behavior; they do not claim every mid-function
interleaving with the still-inverted request path is deadlock-free. Debug and
manual quote audits are in `docs/ovd979-lock-order.md`. Exact-head independent
migration review and hosted gates remain integration work; no commit, push,
PR operation, hosted apply or production action is part of this worktree task.
