# OVD-979 U3: extraction attempt identity

U3 is stacked on U2. It adds nullable `work_queue.attempt_id uuid` and
`drawing_extractions.source_attempt_id uuid`, with `ADD COLUMN IF NOT EXISTS`
and no defaults or backfill. Null denotes legacy evidence; U4 must require
non-null matching attempt IDs before accepting finishing evidence. This unit
adds no auto-approval gate, unique index, request-extraction change, deferred
release mechanism, or backstop change. The one-hour backstop decision stands.

## Application and rollback

- `supabase/migrations/20261030164800_ovd979u3_extraction_attempt_identity.sql`
  is the only forward copy. The duplicate draft and the stored rollback were
  deleted in repair round 1 (Sonar duplication gate); the rollback is generated.
- **Deploy order: migration before worker.** The updated worker writes
  `drawing_extractions.source_attempt_id` and `work_queue.attempt_id = null`.
  If it ran before the columns exist, PostgREST would reject both writes:
  extraction results would fail and so would the retry requeue, stranding tasks
  as `running`. Merging this PR applies the migration, but it does not
  redeploy the worker image (`deploy-cloud-run.sh` is a manual operator step;
  see `docs/provider-integration.md`). Deploy the worker only after the
  migration has applied in that environment, and check that both columns exist
  first. Never deploy this worker to an environment that lacks the migration.
- No function signature, owner, grant recipient, policy or index changes.
- `api_claim_next_task(text)` retains `FOR UPDATE SKIP LOCKED`, claim ordering,
  lock metadata and attempt counting. Every claim, for every task type, sets
  a fresh `gen_random_uuid()`. Its lock sequence remains L5 then L5.
  The forward function pins `search_path = pg_catalog, public`, revokes
  PUBLIC/anon/authenticated and retains service_role-only execution, matching
  the post-OVD-535 ACL.
- Rollback: `node scripts/ovd979-rollback.mjs
  20261030164800_ovd979u3_extraction_attempt_identity.sql` prints the original
  claim definition from `20260324120000_add_api_claim_next_task.sql`, body
  bytes unchanged, with the current post-OVD-535 ACL. Its search path is
  emitted as `pg_catalog, public, pg_temp`, not the historical
  `public, pg_temp`, so `lint-security-definer` would accept it as a forward
  migration. `prosrc` and its md5 are unaffected. Restored `md5(prosrc)` is
  `31a545de0aa0ab7d881d02193edabfb8`.
  **Both nullable columns and recorded values remain** to avoid data loss.
  The restored claim body never touches `attempt_id`, so a row claimed after
  rollback keeps whatever `attempt_id` it already holds: null for rows queued
  by the worker's retry path, possibly a stale earlier id for rows requeued by
  other paths. The updated worker copies that value into `source_attempt_id`.
  Rollback does not rewrite existing rows.
- **Rollback order: roll back U4 before U3.** U4's gate trusts `attempt_id`
  to be fresh per claim, which only this unit's claim body guarantees.
- Forward and rollback contain no transaction wrapper; apply each in one
  transaction. Both support repeat application.
- The unchanged collision checker passes without a `function-supersessions.json`
  entry. The plan's convention lists one for a replaced deployed body
  (`api_claim_next_task`); that entry is tracked in U6 against the sha256 of
  `20260324120000_add_api_claim_next_task.sql`.
- Only `worker/src/queue.ts` `markTaskQueuedForRetry` clears `attempt_id` on
  requeue. Other paths that set `status = 'queued'` (SQL resets, stale-lock
  and backstop recovery, U5's deferred release) keep the old id. Claims stay
  correct because every claim writes a fresh uuid. U4's gate must therefore
  match only `status = 'running'` rows with a non-null `attempt_id`.

## Worker write and access boundaries

`claimNextTask` returns the RPC's composite queue row, including `attempt_id`.
`handleExtractTask` uses a direct Supabase/PostgREST table upsert, not an
extraction-write RPC. The SQL side of that path is the new nullable column on
`drawing_extractions`; the worker includes `source_attempt_id` in the same
upsert as the extraction result. Missing or null legacy claim IDs explicitly
write null, so an upsert cannot retain an earlier attempt's provenance.
Canonical artifact reuse does not manufacture a new claim identity.

Existing extraction retries converge on `markTaskQueuedForRetry`. Its guarded
update clears `attempt_id` together with the worker lock and queued status;
its existing status/attempt-counter/worker predicates still reject a stale
handler. The next atomic claim generates a new UUID. The shared helper also
clears identities for other task types. No SQL requeue function is added.

Existing policies on both tables permit writes for internal staff and the
service role; organization clients cannot insert or update either identity.
The pgTAP suite exercises a real authenticated client membership and verifies
zero-row updates, rejected inserts, and denied claim execution. Anonymous
claim execution remains denied. No RLS policy changes are needed.

Generated database types reflect the nullable fields. Existing typed fixtures
and the local extraction-lab preview object explicitly use null; there is no
new UI behavior. The worker record accepts an absent field for pre-U3 claim
responses and persists it as null.

## Local verification (2026-10-30 UTC)

Owner: OVD-979 U3 `/root`, host/worktree/resource IDs in
`/tmp/ovd979-u3-proof/owner.json`, branch `fix/ovd979-u3-attempt-id`, source
base `9fe986c7edb5fd984502e97437fc05724a70d462` plus the recorded working-tree
file hashes. No commit, push, PR, hosted database or existing stack operation.
The exclusively owned fixture uses cached `supabase/postgres:17.6.1.095`,
an internal network, no ports, read-only root, tmpfs data, 1 CPU, 1 GiB memory,
256 PIDs and a 30-minute process deadline. All 161 prior repository migrations
were replayed, using the platform shim extracted from the maintained
`scripts/local-pg17-sentinel-proof.sh`. Only SQL/catalog/RLS behavior is proven;
GoTrue and PostgREST transport are outside this fixture.

- `node scripts/check-lock-order.mjs`: PASS. U3 claim remains L5-only; the
  expected U5 request-path inversion is unchanged. No checker changes.
- `node scripts/lint-security-definer.mjs --all --enforce`: PASS, zero failing
  definitions or baseline additions.
- `node scripts/check-migration-function-collisions.mjs`: PASS.
- Targeted Vitest: PASS, 78 tests across queue, real extraction handler,
  export-rescan retry, U3 artifacts, lock checker and existing auto-approval
  regression suites. The handler tests cover two distinct UUIDs, null and an
  absent legacy ID on the actual extraction upsert call.
- Affected frontend fixture suites: PASS, 36 tests.
- `npm run typecheck`, `npm --prefix worker run typecheck`, and targeted ESLint:
  PASS.
- `supabase/tests/ovd979u3_attempt_identity.sql`: PASS, 27 pgTAP assertions.
  Fresh claims, reclaims by the same worker, retry clearing, extraction
  upserts, legacy nulls, nullable UUID columns and client write denial.
- Local `roundtrip.sql`: PASS, 13 pgTAP assertions. Inserts legacy rows before
  adding columns; verifies no backfill, repeated forward application without
  data/catalog changes, rollback body MD5/ACL/search-path restoration,
  retained nullable columns/provenance, repeat rollback and reapply.
- Negative control: restoring the old claim function fails four UUID assertions;
  reapplying the forward makes all 27 pass again.

Round 0 kept its runner inputs in an uncommitted `/tmp/ovd979-u3-proof/`
directory that no longer exists. Its roundtrip is replaced by the committed
generator proof below.

## Repair round 1 (2026-10-30)

- The duplicate forward draft and the stored rollback are deleted; the rollback
  is generated by `scripts/ovd979-rollback.mjs` and pins `pg_catalog` first.
- Committed roundtrip proof: `node scripts/ovd979-rollback.mjs
  20261030164800_ovd979u3_extraction_attempt_identity.sql --prove --db-url
  <loopback URL>`, on the isolated local fixture with U2 and U3 applied. It
  runs in one transaction that always rolls back:

  ```
  applied migration differs from the prior bodies: PASS
  rollback restores md5(prosrc) of 1 prior bodies, path pg_catalog first: PASS
  rollback keeps the applied ACLs: PASS
  second rollback is a no-op: PASS
  re-apply restores the applied bodies, ACLs and config: PASS
  ovd979 rollback proof: PASS (20261030164800_ovd979u3_extraction_attempt_identity.sql)
  ```

  The re-apply step re-runs `ADD COLUMN IF NOT EXISTS` as a no-op. The
  `ephemeral-db` rollback stage replays only `.rollback.sql` files paired with
  a forward draft, so it never ran U3's rollback; this proof replaces it.
- `supabase/tests/ovd979u3_attempt_identity.sql`: 27/27 on the same fixture.
- Deploy order and rollback order are stated above.

Exact-head independent review and hosted release qualification remain separate
integration work. At the time of writing, U3 left the attempt gate to U4 and
request deduplication and deferred release to U5; both have since landed in
their PRs (#986, #988). See the status section below.

## Status (OVD-979 U6)

Retired. Repair round 1 deleted the forward draft copy and the stored rollback
instead of adding a `SUPERSEDED` header: the copies duplicated the promoted
migration (Sonar duplication gate), and with no copy left nothing can replay
this unit's bodies over a later unit's, so the function-collision check passes
on every PR in the stack without a header or a `function-supersessions.json`
entry. The rollback is generated by `scripts/ovd979-rollback.mjs`.
`scripts/ovd979-drafts-retired.test.mjs` keeps it that way: it fails if a
forward or rollback copy of U2–U5 reappears, or if any `ovd-979*` draft
defines a function without a `SUPERSEDED` header.
