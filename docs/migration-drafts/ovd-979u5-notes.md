# OVD-979 U5: request dedupe and drawing release

Stacked on U2/U3/U4. The forward migration is
`supabase/migrations/20261101120200_ovd979u5_drawing_extraction_dedupe.sql`,
the only forward copy since repair round 1. Apply after U4. The file applies
with or without a wrapping transaction: the table lock, duplicate audit and
index build share one `DO` statement.
The request eligibility and failed/completed drawing identity ideas were copied
selectively from draft #874, not cherry-picked. Its second active deferred row
and settlement trigger are not installed. No U2/U3/U4 migration changes here; U5 extends the shared `scripts/ovd979-rollback.mjs` to drop created objects.

## Behavior and locking

`api_request_extraction` verifies authentication/access, takes L0 using the
canonical `ovd979:job:<id>` key, locks and writes L1, locks existing L2 rows in
ID order (`FOR NO KEY UPDATE`), reconciles files, then locks **queued and running** extract tasks in
ID order at L5. All subsequent writes are L5. Request job-status planning uses
plain reads of `job_part_file_set` before L2 writes, so there is no later L1
write. Never-extracted new parts retain the original extracting-status rule;
drawing-only work preserves states outside the four pre-quote statuses.

New tasks always carry `drawingFileId`, including JSON null for CAD-only work.
An extracted `worker-sim-%` part gains one drawing task after attachment;
completed tasks for that drawing suppress another request. Failed/cancelled
work for that drawing can be retried after a partial extraction write. An
extracted CAD-only part without a drawing does not qualify. Initial requests
serialize, and the unique index also guards writers outside this RPC.

A queued task merges the current drawing before claim. If claim wins the
queue lock first, the request waits, rereads the running version and stores
`pendingDrawingFileId` on that same row. There is never a second active row.
The running row keeps its `attempt_id`, so worker settlement (complete and
fail match `id` and not-cancelled; retry also matches `status = 'running'`,
`attempts` and `locked_by`) and its extraction write still find it. U4's gate treats a running row carrying
`pendingDrawingFileId` as pending, so the old attempt's stored result cannot
satisfy the finishing gate for the new drawing. If the drawing is replaced
again while the attempt runs, the next request overwrites the pending value
with the newest drawing.

The BEFORE trigger changes only `NEW`; it acquires no additional row locks and
is `SECURITY INVOKER` (it needs no privilege beyond the updating role's).
It restores the pending marker only when an update to a running row drops it
(a worker writing its claim-time payload); an update that carries its own
pending value, i.e. a newer request, wins. On
completed/failed/cancelled/retry settlement, it merges the pending drawing,
clears claim/error/attempt state, resets the new drawing's retry count and
makes this row queued **immediately**, even when the worker writes its older
claim payload. This reuses the queue row rather than adding a historical task
row; the next claim gets a fresh U3 attempt UUID.

The deferred deadline remains **one hour**. Running pending work records
`now() + interval '1 hour'`; settlement never waits for it. Claim additionally
admits legacy queued `awaitingTaskId` work immediately when its dependency is
terminal or absent, even if availability is still an hour ahead, and removes
the dependency while merging the current drawing. Its ordinary availability
backstop is unchanged. Claim remains L5-only: the part lookup is a plain read.
No worker, reaper, RLS, table owner or grant-recipient changes.

## Index and existing data

`work_queue_one_active_extract_per_part` is a partial **unique (part_id)**
index for extract_part rows whose status is queued/running. **Deviation:** the
plan (and the repair-round brief) name a unique index per (part, drawing).
A per-part index already admits at most one active row per (part, drawing),
and the merge-into-one-row design requires it: a (part, drawing) key would
allow a second active row for a new drawing, so two attempts for one part
could run at once and the older drawing's result could overwrite the newer.
This is stronger than the proposed part/drawing pair. Missing, null and different
payload drawing IDs all share the same part key. Null part IDs have no part
to guard and retain PostgreSQL's ordinary null-key behavior.

Inside one `DO` statement, a SHARE ROW EXCLUSIVE table lock freezes writers
across the duplicate audit and `CREATE UNIQUE INDEX IF NOT EXISTS`. Round 0
put `LOCK TABLE` at top level, which fails with 25P01 when the runner does not
wrap the file in a transaction (CI's `supabase start`/`db push`). The block
aborts if any non-null part has multiple active extract tasks; it never cleans
up data. There is no check/build race. The lock blocks worker claims and
settlements for the scan of active extract rows plus the partial-index build;
record the hosted `work_queue` row count in the pre-apply audit to size the
apply window (the local fixture has 0 rows).

### Other `extract_part` writers (ON CONFLICT audit)

Latest definitions of every function that inserts into `public.work_queue`,
plus the worker, server and app code, were scanned in repair round 1:

- `api_request_extraction` (this migration): the only `extract_part` inserter;
  `ON CONFLICT DO NOTHING`.
- `api_request_debug_extraction` inserts `debug_extract_part`,
  `private.queue_export_marking_rescans` inserts `export_marking_rescan`,
  `api_start_quote_run` and `private.request_scoped_automatic_quote_impl`
  insert vendor-quote work. None are covered by the partial index.
- Worker: `markTaskQueuedForRetry` requeues the same running row (no second
  active row); its inserts are `repair_adapter_candidate` and
  `generate_cad_preview`. No SQL function sets an `extract_part` row back to
  `queued`. The app only reads `work_queue`.

### Pre-existing parts that will re-extract

By the request's eligibility logic, a part re-queues on its job's **next**
`api_request_extraction` call (nothing happens at migration time) when it has
a `drawing_file_id`, its stored extraction is `worker-sim-%` (or a failed or
cancelled task names its current drawing), no completed task names its
current drawing, and it has no active task. Pre-U5 completed tasks never carry
`drawingFileId`, so **every part with a drawing and a `worker-sim-%`
extraction re-extracts once**; parts with a real extractor result and no failed
task for the current drawing do not. Local count: **0 parts, 0 jobs** (the
isolated fixture and the repository seeds contain no such rows). Staging and
production were not queried. The read-only count for the rehearsal, to run
before Blaine's card:

```sql
select count(*) as parts_that_would_reextract, count(distinct part.job_id) as jobs_affected
from public.parts part
join public.drawing_extractions extraction on extraction.part_id = part.id
where part.drawing_file_id is not null
  and (extraction.extractor_version like 'worker-sim-%' or exists (
    select 1 from public.work_queue failed
    where failed.part_id = part.id and failed.task_type = 'extract_part'
      and failed.status in ('failed', 'cancelled')
      and failed.payload->>'drawingFileId' = part.drawing_file_id::text))
  and not exists (
    select 1 from public.work_queue done
    where done.part_id = part.id and done.task_type = 'extract_part'
      and done.status = 'completed'
      and done.payload->>'drawingFileId' = part.drawing_file_id::text)
  and not exists (
    select 1 from public.work_queue active
    where active.part_id = part.id and active.task_type = 'extract_part'
      and active.status in ('queued', 'running'));
```

### Lock-order checker edits

`KNOWN_INVERSIONS` loses `api_request_extraction` (tightening). The one
allowlist addition is `job_part_file_set` under `api_request_extraction`'s
unaudited callees. It is `LANGUAGE sql STABLE` with only plain `SELECT`s over
`job_files` (no `FOR UPDATE`/`FOR SHARE`, no writes), so it takes no row locks,
and it is already allowlisted for `api_reconcile_job_parts` on main. The
worker's settlement path is one PostgREST `work_queue` update (L5 only; this
trigger rewrites `NEW` and locks nothing). `api_refresh_job_extraction_status`
runs afterwards in its own transaction: it locks L1 `jobs` and only reads
`work_queue`, so there is no L5-then-L1 order. Local proof applies the exact
forward over conflicting missing/different drawing identities and verifies
an abort, no index and unchanged rows, then proves the no-conflict path.

Before any hosted apply, an independently authorized read-only audit must run:

```sql
select part_id, count(*)
from public.work_queue
where task_type = 'extract_part' and status in ('queued', 'running')
  and part_id is not null
group by part_id having count(*) > 1;
```

No hosted database was contacted. Existing-data compatibility is proven for
synthetic fixtures only; any hosted duplicates require operator disposition.

## Rollback and repeat application

`node scripts/ovd979-rollback.mjs
20261101120200_ovd979u5_drawing_extraction_dedupe.sql` generates the rollback:
it drops the trigger, its private helper and the index, then restores both
U4-era function definitions (request from U2's migration, claim from U3's)
and ACLs, all with `pg_catalog` first in `search_path`. The stored
`ovd-979u5.rollback.sql` was deleted (Sonar duplication), and so was the
`ovd979u5_rollback.sql` pgTAP that `\ir`-included it; the generator's
`--prove` mode replaces it.
Authenticated/service_role request access and service-only claim access stay
unchanged, with PUBLIC/anon revoked. U4 auto approval is unchanged.

Repeat rollback and repeat forward preserve definitions, ACLs and task data.
Rollback deliberately does not rewrite task data or U3 columns. Drain pending
merged drawing work before a release rollback: U4's gate still treats a
running row with `pendingDrawingFileId` as pending, but without the trigger
nothing requeues the successor drawing when that attempt settles. The complete function bodies and exact
rollback exceed the usual line budget; the behavioral change is one bounded
request/claim lifecycle unit, and SQL mirrors are required review artifacts.

## Local verification (2026-10-30 UTC)

Owner `/root`, worktree `/workspace/ovd979-u5`, branch
`fix/ovd979-u5-request-extraction`, source base
`9d5dc650e8ba3447db8e1d4d2fad8d4ba81945ef` plus recorded working-tree hashes.
Evidence, runner scripts and the owner/resource ledger are in
`/tmp/ovd979-u5-proof/`. The exclusively owned cached PostgreSQL 17.6.1.095
Docker fixture used an internal network, no published ports, read-only root,
tmpfs data, 1 CPU, 1 GiB memory, 256 PIDs and a 30-minute server deadline. It
replayed all 163 prior migrations using the maintained local sentinel platform
shim. Dependencies were reused locally without installation or manifest edits.

- Lock-order check and enforced SECURITY DEFINER lint: PASS; no baseline edits.
  Only exact lock-check expectation data changes (resolved inversion removal
  and the read-only file-set callee). Targeted ESLint and diff whitespace: PASS.
- Vitest: PASS, 45 tests across U2/U3/U5 artifacts, auto approval and lock order.
- Required pin helper and CI-profile Node tests: PASS, 48 tests.
- U5 request/claim pgTAP: PASS, 51 assertions, including observed pg_locks waits
  in both claim/request directions, concurrent initial requests, all settlement
  paths, correction preservation, immediate release, status and ACL behavior.
- U5 rollback/reapply pgTAP: PASS, 13 assertions, exact body MD5s, ACLs/search
  paths, dropped objects, unchanged U4 body and no data rewrites.
- Exact-forward conflict proof: PASS, 5 assertions.
- Existing U2 contention, U3 identity/RLS and canonical identity pgTAP: PASS,
  85 assertions. Runner copies set `ovd.test_conninfo` to the fixture socket;
  committed test files and their local fallback remain unchanged.
- Total positive pgTAP: **154 assertions**. Prior-request negative control:
  all three AC2 assertions fail as expected; U5 is reapplied afterward.

Round 0 kept these logs in an uncommitted `/tmp/ovd979-u5-proof/` directory,
which no longer exists.

## Repair round 1 (2026-10-30)

On the isolated local fixture (U2–U5 applied):

- `supabase/tests/ovd979u5_request_extraction.sql`: 56/56. New assertions: the
  request keeps the running `attempt_id`; a drawing replaced mid-task leaves the
  newest drawing pending; settlement through the worker's own predicates
  matches one row; the trigger helper is not SECURITY DEFINER. Against the
  round-0 body four of them fail (`attempt_id`, mid-task replacement, stale
  payload restore, SECURITY DEFINER).
- The dblink credential fallback is gone; sessions log in as a per-run role
  with a random password, dropped at the end.
- The forward applies with `psql` and no wrapping transaction, including the
  index build from scratch (round 0 failed here with 25P01).
- `node scripts/ovd979-rollback.mjs
  20261101120200_ovd979u5_drawing_extraction_dedupe.sql --prove --db-url
  <loopback URL>`:

  ```
  applied migration differs from the prior bodies: PASS
  rollback restores md5(prosrc) of 2 prior bodies, path pg_catalog first: PASS
  rollback drops 3 created objects: PASS
  rollback leaves rows of public.work_queue unchanged: PASS
  rollback keeps the applied ACLs: PASS
  second rollback is a no-op: PASS
  re-apply restores the applied bodies, ACLs and config: PASS
  re-apply recreates 3 created objects: PASS
  re-apply leaves rows of public.work_queue unchanged: PASS
  ovd979 rollback proof: PASS (20261030190000_ovd979u5_drawing_extraction_dedupe.sql)
  ```

  The fixture's `work_queue` is empty, so the two row checks are weak there.
- Claim still compares `dependency.id::text` with `awaitingTaskId` (Architect
  low item 11). A `::uuid` cast would let one malformed legacy value fail every
  claim, so it is left as is; it matters only if the queue grows large.
- Lock-order, SECURITY DEFINER lint and function-collision checks: PASS.

## Repair round 2 (2026-10-31)

- **Migration renamed `20261030190000` → `20261031025000`.** Main gained
  `20261030204050_ovd1018_restrict_project_jobs_writes.sql`, so the U5 file
  sorted before main's head and `verify:migration-lineage --against-base`
  failed. This is a rename only: the bytes and SHA-256 (`7263cb9f…`) are
  unchanged, so the round 1 rollback proof above, recorded under the old
  filename, still covers this content. Neither OVD-1018 nor OVD-1073's
  `reconcile_claim_fence` defines a function that U2–U5 define, so apply order
  against them does not change behavior.
- **Stack follow-up (not in this PR).** U4 (#986) has renamed its migration
  to `20261030204300`, and this PR merges that base. The U2 and U3 migrations
  (`20261030162500`, `20261030164800`) still sort before `20261030204050` and
  keep `lint` red until #984 and #985 rename them. U4's notes reserve
  `20261030204100` and `20261030204200` for U2 and U3, which keeps
  U2 < U3 < U4 < U5. If any of them lands later than `20261031025000`, U5 must
  be renamed again so it stays last.
- **Sonar.** All 26 new-code findings are `plsql:S1192` (duplicated literal),
  in the U5 migration, the U5 pgTAP suite and the U4 pgTAP cases this PR
  adapts. The literals are persisted states (`queued`, `running`), the
  `extract_part` task type, payload wire keys (`drawingFileId`,
  `pendingDrawingFileId`) and independent expected test values across
  separate SQL scopes. Under the repository's PostgreSQL contract-literal
  policy (see `docs/engineering-worker-sessions.md` and
  `docs/engineering-change-queue.md`) they are dispositioned as false
  positives. No exclusion or Sonar configuration change was made, and no
  security rule was disabled. The quality gate passes.

## Council findings @ bfc07504 (2026-10-31)

Council consensus FAIL (Opus PASS_NOTES, GPT FAIL, Jev PASS_NOTES).

- **Stale settlement of a reused row (GPT, major): fixed.** `markTaskCompleted`
  and `markTaskFailed` (`worker/src/queue.ts`) filter by `id` and
  not-cancelled only. After the reaper fails a running row that carries a
  pending drawing, this trigger requeues the successor on the same id, so the
  old attempt's late settlement used to complete it with the old payload. The
  trigger now skips (`RETURN NULL`) a status change to queued, completed or
  failed on a queued or running `extract_part` row when the settling payload's
  `drawingFileId` differs from the row's. Every worker settlement writes its
  claim-time payload plus a patch without `drawingFileId`, and the reaper
  keeps the payload, so legitimate settlements are unaffected; same-status
  writes (request merges, claim) are not fenced. Residual: if the drawing goes
  A→B→A while A runs, the successor's claim re-reads A, and a late A
  settlement is then indistinguishable from the successor's own (same drawing,
  redundant work only). The new U5 SHA-256 is
  `ed01e6e1d95495ce7ceef9d768de76e210c0a67157602785a884417b070b9fb6`.
- **Rollback row proof baseline (GPT, minor): fixed.** `--prove` now snapshots
  rows before the first rollback, so rollback itself is checked.
- **U4 canonical reuse vs the attempt gate (GPT, major): not this PR's file.**
  `20261101120100_ovd979u4_attempt_bound_auto_approval.sql` belongs to #986.
- **Cancel hands over to the successor (Opus, minor): documented.** Excluding
  `cancelled` would drop the successor permanently: a later request re-queues
  only for a sim extraction or a failed/cancelled task naming the *current*
  drawing. No SQL path cancels `extract_part` today.
- **Successor resets attempts and backoff (Opus, minor): documented** in the
  trigger comment; it happens once per pending drawing.
- **Stale pending after A→B→A or removal (Opus, minor): left.** Clearing it in
  the request needs the trigger to tell a request's write from a worker's
  claim-time payload write (both drop the key). The cost is one redundant
  extraction.
- **`extracting` from the pre-reconciliation prediction (Opus, minor): left**,
  the stated trade-off for writing L1 before L2; the status refresh recovers it.

Local verification (disposable PostgreSQL 16.15 on loopback, minimal Supabase
platform shim, all 166 migrations replayed; the pinned 17.6.1.095 image could
not be pulled, registry rate limit): pgTAP U2 53/53, U3 27/27, U4 89/89,
U5 63/63 (7 new reaped-attempt cases; 5 of them fail against the bfc07504
trigger), OVD-723 167/167; `ovd979-rollback.mjs --prove`: PASS. Staging and
production were not touched.

## Base merge: U3/U4 renames (2026-10-31)

U3 (#985) moved to `20261031034754` and U4 (#986) to `20261031034800`, both
after this file's `20261031025000`. U5 must apply after U4, so it was renamed to
`20261031034900_ovd979u5_drawing_extraction_dedupe.sql`. This was a rename only;
the SHA-256 (`ed01e6e1…`) was unchanged. Only U2 (#984, `20261030162500`) still
sorted before main's `20261030204050` and kept `lint` red.

## Base merge: U2 rename (2026-10-31)

U2 (#984) moved to `20261031034700_ovd979u2_canonical_requirement_lock_order.sql`
(bytes and SHA-256 `572066174ddb…906f` unchanged), after main's
`20261030204050` and before U3's `20261031034754`. U5 kept `20261031034900`,
so the stack order was U2 < U3 < U4 < U5 and every OVD-979 migration sorted after
main's newest at the time.

## Re-timestamp (2026-11-01)

Main gained `20261101110559_reconcile_claim_fence_followups.sql`, so the whole
stack was re-timestamped past it: U2 `20261101115900` (#984), U3
`20261101120000` (#985), U4 `20261101120100` (#986) and this file
`20261101120200_ovd979u5_drawing_extraction_dedupe.sql`. Rename only; the U5
SHA-256 (`2c28901d…`) is unchanged. `scripts/ovd979u5-migration.test.mjs` names
U2's and U3's new filenames as the prior definitions of
`api_request_extraction(uuid)` and `api_claim_next_task(text)`.
