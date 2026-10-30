# OVD-979 U5: request dedupe and drawing release

Stacked on U2/U3/U4. The forward migration is
`supabase/migrations/20261030190000_ovd979u5_drawing_extraction_dedupe.sql`,
byte identical to `ovd-979u5.sql` (SHA-256
`056d347e7061d7f189ca9ac0594c47fc17fb3d9932d112bb4d4c93b6a5fc9b93`).
Apply transactionally, after U4. Neither SQL file has a transaction wrapper.
The request eligibility and failed/completed drawing identity ideas were copied
selectively from draft #874, not cherry-picked. Its second active deferred row
and settlement trigger are not installed. No U2/U3/U4 artifacts are changed.

## Behavior and locking

`api_request_extraction` verifies authentication/access, takes L0 using the
canonical `ovd979:job:<id>` key, locks and writes L1, locks existing L2 rows in
ID order, reconciles files, then locks **queued and running** extract tasks in
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
The obsolete running attempt is invalidated with `attempt_id = null`: its
stored CAD extraction cannot satisfy U4's finishing gate for the new drawing.
This is not a legacy identity backfill.

The BEFORE trigger changes only `NEW`; it acquires no additional row locks.
It preserves a pending marker across stale running-payload updates. On
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
index for extract_part rows whose status is queued/running. This is stronger
than the original proposed part/drawing pair. Missing, null and different
payload drawing IDs all share the same part key. Null part IDs have no part
to guard and retain PostgreSQL's ordinary null-key behavior.

Before `CREATE UNIQUE INDEX IF NOT EXISTS`, a SHARE ROW EXCLUSIVE table lock
freezes writers across the duplicate audit and index build. The DO block
aborts if any non-null part has multiple active extract tasks; it never
cleans up data. There is no check/build race. Local proof applies the exact
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

`ovd-979u5.rollback.sql` removes the index, trigger and its private helper and
restores both complete U4-era function definitions and ACLs. Request body
`md5(prosrc)` is **7b2804b18559df073dcd4651e80b3ce6**; claim body is
**0dcaaf41268ad9c84f4433b8b437e42b**. The request's original public search path
is restored as part of rollback; forward definers pin pg_catalog, public.
Authenticated/service_role request access and service-only claim access stay
unchanged, with PUBLIC/anon revoked. U4 auto approval is unchanged.

Repeat rollback and repeat forward preserve definitions, ACLs and task data.
Rollback deliberately does not rewrite task data or U3 columns. Drain pending
merged drawing work before a release rollback: the restored U4 functions do
not interpret U5's pending marker. The complete function bodies and exact
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

`pgtap.log`, `conflict.log`, `regression.log`, `negative.log`, `vitest.log`,
`profile.log`, `locks.log`, `security.log`, and `owner.json` bind the evidence.
One rollback-test alias ambiguity was corrected before its passing run. The
initial socket-readiness and test-directory setup failures were infrastructure
only. This proves local SQL/catalog/RLS behavior, not GoTrue/PostgREST transport,
worker deployment, hosted data readiness or production qualification. Exact-head
independent migration review and OVD-976 release verification remain integration
requirements. No commit, push, rebase, PR or hosted operation was performed.
