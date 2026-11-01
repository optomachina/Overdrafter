# OVD-979 U4: attempt-bound auto approval

U4 is stacked on U2 and U3. It changes
`public.api_auto_approve_job_requirements(uuid)` and, since repair round 6,
adds two attempt-fenced worker RPCs,
`public.api_save_drawing_extraction_for_attempt(uuid, uuid, jsonb)` and
`public.api_reuse_trusted_part_version_artifacts_for_attempt(uuid, uuid, uuid, uuid)`
(see "Attempt fence" below), with the worker change that calls them. U2's
`public.api_reuse_trusted_part_version_artifacts(uuid, uuid, uuid)` is no
longer redefined. It preserves U2's L1 job lock and ordered L2/L3/L4 write
phases with U2's `FOR NO KEY UPDATE` strength, existing grants, quantities,
vendors, audit payload and failed-task count. It adds no schema, backfill,
request RPC, unique index or task settlement. The deferred backstop stays one
hour. The bodies and test scenarios were copied selectively from draft #874,
not cherry-picked; its timestamp exemption and finishing-task ID cache are
absent.

## Behavior

- A queued extraction task is pending. A running extraction task is finishing
  only when its non-null `attempt_id` equals the stored extraction's
  `source_attempt_id` for that same part. This is a hard requirement, not an
  optimization: only the worker retry path (`worker/src/queue.ts`
  `markTaskQueuedForRetry`) clears `attempt_id` on requeue, so a row requeued
  by any other path (SQL resets, stale-lock or backstop recovery, U5's deferred
  release) can still carry the id that matches the stored extraction. Both
  gate sites require `status = 'running' and attempt_id is not null`; the
  artifact test fails if either loses that guard, and the pgTAP identity
  matrix includes a queued row that keeps the matching id.
- A running row whose payload carries `pendingDrawingFileId` is pending too,
  even when its attempt matches: U5's request marks a running task this way
  when a newer drawing is attached mid-attempt, so the running attempt cannot
  finish the newly requested drawing. Before U5 the key never exists and the
  guard is a no-op. This replaces U5's round-0 approach of setting
  `attempt_id = null` on the running row. The rollup reads the current tuple
  directly, so a changed/cleared attempt or staff `updated_at` bump is not
  completion evidence. No task reason or timestamp makes an exception.
- While any active task for a part lacks matching running-attempt evidence,
  its stored extraction is ignored for refresh/requirement creation and its
  extraction status is left alone. Existing requirements remain available.
  Historical extraction rows with no active task retain ordinary approval
  behavior; null identities never exempt active work.
- Description, part number, revision and finish are user-owned when legacy
  `fieldSources` is not `auto` OR the property editor has an override key.
  Corrections and quote values survive re-extraction. Existing editor defaults
  follow fresh, unflagged extraction values even for override-owned fields,
  allowing immediate reset; legacy-only ownership keeps its defaults. Missing,
  older or review-flagged values do not move an owned default. Ownership is
  not copied into sticky legacy provenance.
- Auto-owned `Unknown material` is replaced when extraction provides material;
  explicit material overrides and legacy material ownership survive. Unrelated
  provenance keys are preserved on repeated calls.
- Only uploaded, extracting, needs_spec_review and ready_to_quote jobs change
  status. The actual enum has **10 total statuses, six outside pre-quote**,
  rather than ten outside pre-quote as the acceptance wording suggests. The
  suite exercises every enum value under pending, failed and successful work.

## Deploy order (required)

**U3 migration -> worker deploy -> U4 migration.** Do not apply U3 and U4
back to back. Once U3 is applied every claim sets `work_queue.attempt_id`, but
a pre-U3 worker never writes `drawing_extractions.source_attempt_id`. U4's gate
would then treat each of that worker's running extractions as pending: the
in-task `api_auto_approve_job_requirements` call approves nothing and sets
the job to `extracting`, and nothing calls auto approval again for that
attempt. After the task settles, the worker's `api_refresh_job_extraction_status`
call (`worker/src/index.ts`) moves the job on without the fresh extraction
having been applied. A part with no requirement goes to `needs_spec_review`, so
every upload falls to staff review. A part whose requirement already exists
goes to `ready_to_quote` on fields that were never refreshed from the new
extraction.

The U4 migration enforces this itself. Its first statement
(`$ovd979u4_worker_guard$`) raises `OVD-979 U4 requires the worker that
writes drawing_extractions.source_attempt_id` and aborts the transaction when:

- the database has any `extract_part` row but no completed one whose attempt
  stamped its part's extraction (the new worker has not completed an
  extraction yet, including the U3-then-U4-back-to-back case), or
- a claim made since U3 (non-null `attempt_id`) completed later than the
  newest stamped one and left its part's extraction unstamped (an old worker
  is still running).

Completion time is the task's `updated_at`. Trusted reuses
(`payload.reusedCanonicalPartVersion`) are not evidence either way, because
U2's reuse copy carries no stamp, and an extraction row last written before
the claim was created is not evidence. A database with no `extract_part`
rows (fresh, CI, `db reset`) has nothing to strand, so the guard is a no-op.
The guard reads the newest evidence only; stopping every old worker before
applying U4 stays an operator step. To apply: deploy the worker everywhere,
let one real (non-reuse) extraction complete, then apply U4.
`supabase/tests/ovd979u4_worker_guard.sql` (8 assertions) runs the guard
block verbatim; the artifact test fails if the copies drift.

## Apply and rollback

`supabase/migrations/20261101120100_ovd979u4_attempt_bound_auto_approval.sql`
is the only forward copy. Apply after U2/U3 and after the worker deploy
(above), in one transaction. Both forward and rollback support repeated application
and have no transaction wrapper. No table, policy, owner or grant recipient
changes. The function keeps `SECURITY DEFINER`, pins
`search_path = pg_catalog, public`, revokes PUBLIC/anon/authenticated and
retains service_role-only execution.

The rollback is generated: `node scripts/ovd979-rollback.mjs
20261101120100_ovd979u4_attempt_bound_auto_approval.sql` drops the two new
functions and prints the complete U2/U3-era definition of auto approval (from
U2's migration) and its ACLs;
auto approval's `md5(prosrc)` is **ba94c43be2ec78486ee9aca4679d2465**. The
artifact test compares the generated bodies directly to U2's promoted
migration. Roll back U4 before U3.

The complete forward body and byte-exact rollback exceed the normal line
budget. The behavioral change is one function; splitting it would not yield
independent changes. U2's forward draft copy no longer exists (deleted in U2's
repair round 1), so nothing can replay U2's auto-approval body over U4 and the
unchanged collision guard passes on this PR alone. No
`function-supersessions.json` exception or checker/baseline change is needed.

## Local verification (2026-10-30 UTC)

Owner: OVD-979 U4 `/root`, worktree `/workspace/ovd979-u4`, source base
`f2c600e96` plus working-tree hashes in `/tmp/ovd979-u4-proof/owner.json`.
The exclusively owned local Docker fixture uses cached
`supabase/postgres:17.6.1.095`, an internal network, no published ports, a
read-only root, tmpfs data, 1 CPU, 1 GiB memory, 256 PIDs and a 30-minute server
deadline. Its bootstrap comes from `scripts/local-pg17-sentinel-proof.sh`.
All 162 prior migrations were replayed; historical concurrent-index migration
replay uses autocommit. New forward/rollback files were applied transactionally.
No existing stack or hosted project was contacted. Dependencies were reused
from the existing U3 worktree without installation or manifest changes.

- `node scripts/check-lock-order.mjs`: PASS. Auto approval remains L1/L2/L3/L4;
  U5's already-recorded request-path inversion remains unchanged.
- `node scripts/lint-security-definer.mjs --all --enforce`: PASS, no failures
  or baseline additions. Function collision check: PASS.
- Targeted Vitest: PASS, 42 assertions across auto-approval artifacts, U2/U3
  artifacts and the lock-order checker. App typecheck and targeted ESLint: PASS.
- `ovd979u4_auto_approval.sql`: PASS, 86 pgTAP assertions. Real client save and
  reset, real staff approval timestamp bump, queued/cleared/changed/null
  identities, wrong-part evidence, matching running attempt even with an older
  timestamp than its lock, default synchronization, legacy provenance, material,
  repeated calls, all ten statuses and service-only execution.
- Rollback/reapply catalog proof: PASS, 9 assertions.
- Existing U2 contention, U3 identity/RLS and canonical identity suites: PASS,
  85 assertions. U2's temporary runner copy changes only its dblink host from
  `127.0.0.1` to the fixture's `/tmp` socket; all 45 assertions are unchanged.
- Combined final pgTAP: PASS, **180 assertions** across five files.
- Prior-body negative control fails 42 of the 86 U4 assertions, detecting the
  ownership, attempt and status regressions; reapplying U4 restores the full
  180-assertion combined pass.

Round 0 kept its runner inputs in an uncommitted `/tmp/ovd979-u4-proof/`
directory that no longer exists; the roundtrip is replaced by the committed
generator proof below.

This proves SQL/catalog/RLS behavior and observed lock contention; it does not
prove GoTrue/PostgREST transport or hosted release qualification. Exact-head
independent migration review remains integration work. No commit, push, rebase,
PR, hosted apply, production or provider operation was performed.

## Repair round 1 (2026-10-30)

- Merged repaired U3 (and through it U2). The U2 forward draft that made the
  collision lint fail on this PR is gone, so `check-migration-function-collisions`
  passes here without a header or supersession entry.
- Deleted the duplicate `ovd-979u4.sql` and the stored `ovd-979u4.rollback.sql`
  (Sonar duplication); the rollback is generated and pins `pg_catalog` first.
- Gate: an artifact test now requires both gate sites to keep
  `queue.status = 'running' and queue.attempt_id is not null`; the pgTAP queued
  case is labelled as the SQL-path requeue that keeps a matching id.
- Successor-drawing guard (above): both gate sites also require
  `not (queue.payload ? 'pendingDrawingFileId')`. New pgTAP case (3
  assertions, 89 total); against the round-0 U4 body those 3 fail.
  The migration sha256 pin was then
  `9fe36b10e3e0b1f25d7d386909ea9595772730c6bfef9e9153fd5d82337d6be6`.
- On the isolated local fixture with U2–U4 applied: `ovd979u4_auto_approval.sql`
  89/89, `ovd979u2_lock_order.sql` 53/53, `ovd979u3_attempt_identity.sql` 27/27.
  `node scripts/ovd979-rollback.mjs
  20261030165700_ovd979u4_attempt_bound_auto_approval.sql --prove --db-url
  <loopback URL>`:

  ```
  applied migration differs from the prior bodies: PASS
  rollback restores md5(prosrc) of 1 prior bodies, path pg_catalog first: PASS
  rollback keeps the applied ACLs: PASS
  second rollback is a no-op: PASS
  re-apply restores the applied bodies, ACLs and config: PASS
  ovd979 rollback proof: PASS (20261030165700_ovd979u4_attempt_bound_auto_approval.sql)
  ```

## Repair round 2 (2026-10-31)

- The `lint` job's migration-lineage check (`--against-base`, which compares
  against `main`) failed because U4 sorted before main's newest migration,
  OVD-1018 `20261030204050_ovd1018_restrict_project_jobs_writes.sql`.
- Renamed U4 to `20261030204300_ovd979u4_attempt_bound_auto_approval.sql`.
  The bytes are unchanged, so the sha256 pin stays `9fe36b10…7d6be6`. The round-1
  proof above ran under the old name `20261030165700_…` on identical bytes.
  OVD-1018 does not touch `api_auto_approve_job_requirements`. The generated
  rollback is unchanged (still taken from U2's body), and the collision,
  lock-order and security-definer checks pass.
- `main` is not merged here. This PR's base is the U3 branch, so main arrives
  through the stack.
- `20261030204300` leaves `20261030204100` and `20261030204200` free, so U2
  (#984) and U3 (#985) can rename past OVD-1018 and still sort before U4.
  Until they do, the lineage check on this PR still flags the U2 and U3 files,
  which are inherited from the stack and are not U4's.

## Repair round 3 (2026-10-31): council findings at `0ea7042`

- **Lock strength (major).** Round 0 had changed the three write-phase prelocks
  (parts L2, requirements L3, extractions L4) from U2's `FOR NO KEY UPDATE` to
  `FOR UPDATE`. `FOR UPDATE` conflicts with the KEY SHARE that foreign-key checks
  take, so a concurrent child insert for one of the job's parts (`work_queue`,
  `drawing_preview_assets`, deadline history, ...) waited on auto approval and
  could deadlock against an L1 holder. Restored `FOR NO KEY UPDATE`, as
  `docs/ovd979-lock-order.md` requires. New suite
  `supabase/tests/ovd979u4_lock_strength.sql` (6 assertions, committed fixture,
  dblink): with approval's locks held, an independent session inserts a
  `work_queue` row and a preview row for the part under a 2 s `lock_timeout`.
  Against the `FOR UPDATE` body both inserts fail with `55P03`. The artifact
  test now fails on any `for update` in the migration.
- **Trusted reuse (major).** The worker reuses a trusted part version inside its
  running `extract_part` task and calls auto approval before settling it
  (`worker/src/index.ts`). U2's reuse RPC copied the source extraction without
  `source_attempt_id`, so U4's gate discarded it and a clean reused upload went
  to `needs_spec_review`. U4 now also replaces the reuse RPC: the copied row is
  stamped with the target part's running, non-null `attempt_id`. Nothing else
  in U2's body changes (the artifact test strips the stamp and compares the
  rest byte for byte). An existing target row is still left alone
  (`on conflict do nothing`), keeps its own attempt and stays pending for the
  gate, so that rare retry case does not auto-approve. After the task settles,
  `api_refresh_job_extraction_status` moves the job to `needs_spec_review` when
  the part has no requirement, so the case falls to staff review. New pgTAP case: 4 assertions; against U2's reuse body 3 of
  them fail (`source_attempt_id` null, 0 approved, job stays `extracting`).
- **Ordering (minor).** `pg_temp.u4_store` takes an optional timestamp. New
  case: a matching-attempt extraction stamped before the requirement's
  `updated_at` does not refresh it (2 assertions; 95 total).
- New sha256 pin:
  `1f61517db1c6b479bee60b75acffa403b50ca20b1a1a76de003596f2193bba4b`.
- Local proof: disposable PostgreSQL 16 cluster (unix socket only) with
  `scripts/window-1/supabase-shim.sql` and all 163 migrations on this branch,
  pgTAP and dblink from the distribution packages. `ovd979u4_auto_approval.sql`
  95/95, `ovd979u4_lock_strength.sql` 6/6, `ovd979u2_lock_order.sql` 53/53,
  `ovd979u3_attempt_identity.sql` 27/27, `canonical_part_identity.sql` 13/13.
  `node scripts/ovd979-rollback.mjs
  20261030204300_ovd979u4_attempt_bound_auto_approval.sql --prove`: PASS
  ("rollback restores md5(prosrc) of 2 prior bodies"). No hosted database
  was contacted.

## Base update (2026-10-31): U3 renamed past main

- U3 (#985) moved its migration to
  `20261031034754_ovd979u3_extraction_attempt_identity.sql`, which sorts after
  U4's round-2 name. U4 needs U3's `source_attempt_id` column, so U4 is renamed
  again to `20261031034800_ovd979u4_attempt_bound_auto_approval.sql` (bytes and
  sha256 pin unchanged) after merging the U3 branch. The order is now
  U2 < U3 < U4. U2 (#984) still sorts before main's `20261030204050`; it needs a
  name between `20261030204050` and `20261031034754`.

## Base update (2026-10-31): U2 renamed past main

- U2 (#984) moved its migration to
  `20261031034700_ovd979u2_canonical_requirement_lock_order.sql` (bytes and
  sha256 `572066174ddb…906f` unchanged), between main's `20261030204050` and
  U3's `20261031034754`. U4 keeps `20261031034800`; the order is now
  U2 < U3 < U4. `src/features/quotes/auto-approve-migration.test.ts` reads U2
  under the new filename.

## Repair round 4 (2026-10-31): council finding at `84c04ab`

- **Mixed-version deploy window (major, Opus).** Documented the required
  order U3 migration -> worker deploy -> U4 migration (above) and enforced it
  with a guard at the top of the U4 migration. The guard needs positive
  evidence: on a database with extraction history it refuses until a stamped
  extraction has completed, and it refuses while an old worker is still the
  newest writer. The interrupted WIP version only looked for old-worker
  evidence, so it passed when U3 and U4 were applied back to back, and it
  could refuse after a trusted reuse because auto approval's status update
  bumps the copy's `updated_at`. Against that WIP guard, 4 of the 8 guard
  assertions fail.
- Reuse note above: an existing target row does not auto-approve; the
  worker's post-settle `api_refresh_job_extraction_status` then moves the job
  to `needs_spec_review` (staff review) when the part has no requirement. An
  in-session independent review at `2119f26` corrected this round's first
  wording, which said the job stays in `extracting`. The reuse `on conflict` and
  copied-`updated_at` minors are not changed in this round.
- New sha256 pin:
  `c7770995d71c604bd154639f8bc584d26219656c39fd562fa93ac6cf486a0961`.

## Repair round 6 (2026-11-01): council and ARCH findings at `34a2381`

GPT (council) and the ARCH delta review raised two majors; both were confirmed
in the code and are fixed. The Jev screen (pIncident 0.65 on a schema,
migrations and infra_ci diff) is a risk score, not a code finding; it is
answered by the tests below and stays for the operator's final check.

- **Extraction write race (major).** The worker checked `work_queue` and then
  upserted `drawing_extractions` in two requests, so attempt A could pass the
  check, be reaped, and overwrite successor B's row. The write now goes through
  `api_save_drawing_extraction_for_attempt(p_task_id, p_attempt_id,
  p_extraction)`. In one transaction it upserts the row (L4), with part and
  organization taken from the task, never from the payload, then takes the task's
  `work_queue` row `FOR SHARE` where `status = 'running'` and `attempt_id`
  matches (L5). If that row is gone, the inner block raises `OV979` and rolls the
  write back, and the RPC returns false. Otherwise the share lock is held until
  commit, so a reap (an `UPDATE` of that row) waits for the write to commit and
  the successor writes after it. New two-session suite
  `supabase/tests/ovd979u4_attempt_fence.sql` (9 assertions, committed
  fixture, dblink): with A's write open, a reap fails with `55P03` under a 1 s
  `lock_timeout`. After the reap and B's reclaim, A's late write returns false
  and leaves nothing behind.
- **Stale reuse stamps (major).** U4's reuse picked whatever attempt was
  running on the target and never saw the caller's. A stale worker could stamp
  B's attempt and settle through the reuse path. The new
  `api_reuse_trusted_part_version_artifacts_for_attempt(..., p_expected_attempt_id)`
  calls U2's reuse unchanged, stamps the target row with the caller's attempt
  only when it holds that same copy, then fences on the target's running attempt
  as above. A stale caller gets `attemptSuperseded: true`, and everything it
  copied or stamped is rolled back. The worker logs it and stops, without
  settling or auto-approving.
- **Why U2's reuse is not redefined or overloaded.** The old-worker
  compatibility suites (`supabase/fixtures/worker-compatibility/catalog.sql`,
  `service_role.sql`, run at full head by the free-quote SQL qualification)
  pin the archived worker's exact three-argument identity and exactly one
  overload. U4 therefore leaves U2's body in place and adds a new name. An
  archived worker that is still running gets an unstamped copy, which U4's
  gate keeps pending (the safe direction). Stopping old workers stays the
  operator step above.
- **Deploy window.** The deploy order is unchanged. The new worker runs before
  U4 is applied: on `PGRST202` (RPC not found) it falls back to the legacy
  reuse and the read-then-upsert guard, which narrows the race but cannot close
  it. Once U4 is applied, the fenced RPCs are used.
- **Lock order.** Both RPCs are in `AUDITED_FUNCTIONS`
  (`scripts/check-lock-order.mjs`). Save: L4 upsert, then L5. Reuse: U2's L1, L2
  and L4, then an L4 stamp update, then L5. Neither has an inversion.
- **Rollback.** `scripts/ovd979-rollback.mjs` now drops functions that no
  earlier migration mentions and still refuses a signature whose last earlier
  event is a drop. `--prove` checks that rollback removes the new functions
  and that re-apply restores their bodies, ACLs and config.
- **Rename.** U4 is now `20261101120100_ovd979u4_attempt_bound_auto_approval.sql`,
  after main's `20261101110559` and U3's planned `20261101120000` (#985).
  U3 (#985) has since moved to `20261101120000`, and this branch merged it.
  U2 (#984) was renamed to `20261101115900` on 2026-11-01 and this branch
  merged it, so `verify:migration-lineage --against-base` passes for the
  whole stack: U2 `20261101115900` < U3 `20261101120000` < U4 `20261101120100`.
- Local proof: disposable PostgreSQL 16 (unix socket only),
  `scripts/window-1/supabase-shim.sql` plus all 168 migrations on this branch
  (main merged), pgTAP and dblink from the distribution packages.
  `ovd979u4_auto_approval.sql` 113/113, `ovd979u4_attempt_fence.sql` 9/9,
  `ovd979u4_worker_guard.sql` 8/8, `ovd979u4_lock_strength.sql` 6/6,
  `ovd979u3_attempt_identity.sql` 27/27, `ovd979u2_lock_order.sql` 53/53.
  `node scripts/ovd979-rollback.mjs
  20261101120100_ovd979u4_attempt_bound_auto_approval.sql --prove`: PASS
  (one prior body restored, two new functions dropped and recreated).
  No hosted database was contacted.
- New sha256 pin:
  `3c46872db181f81badc96e2565c21398541b9fbac492a34a97ac54adba764652`.
