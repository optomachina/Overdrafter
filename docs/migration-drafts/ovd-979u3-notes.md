# OVD-979 U3: extraction attempt identity

U3 is stacked on U2. It adds nullable `work_queue.attempt_id uuid` and
`drawing_extractions.source_attempt_id uuid`, with `ADD COLUMN IF NOT EXISTS`
and no defaults or backfill. Null denotes legacy evidence; U4 must require
non-null matching attempt IDs before accepting finishing evidence. This unit
adds no auto-approval gate, unique index, request-extraction change, deferred
release mechanism, or backstop change. The one-hour backstop decision stands.

## Application and rollback

- `supabase/migrations/20261030164800_ovd979u3_extraction_attempt_identity.sql`
  is byte identical to `docs/migration-drafts/ovd-979u3.sql`.
- Apply the migration before the updated worker, which writes the new columns.
  No function signature, owner, grant recipient, policy or index changes.
- `api_claim_next_task(text)` retains `FOR UPDATE SKIP LOCKED`, claim ordering,
  lock metadata and attempt counting. Every claim, for every task type, sets
  a fresh `gen_random_uuid()`. Its lock sequence remains L5 then L5.
  The forward function pins `search_path = pg_catalog, public`, revokes
  PUBLIC/anon/authenticated and retains service_role-only execution, matching
  the post-OVD-535 ACL.
- Rollback restores the original claim definition from
  `20260324120000_add_api_claim_next_task.sql`, including the body bytes and
  original `public, pg_temp` search path, with the current post-OVD-535 ACL.
  Restored `md5(prosrc)` is `31a545de0aa0ab7d881d02193edabfb8`.
  **Both nullable columns and recorded values remain** to avoid data loss.
  New claims after rollback have legacy/null identities on new rows; rollback
  does not rewrite existing rows. The updated worker accepts legacy claims.
- Forward and rollback contain no transaction wrapper; apply each in one
  transaction. Both support repeat application.
- No `function-supersessions.json` exception is needed: the forward draft is
  byte identical to the matching migration. The unchanged collision checker
  passes; its existing rules exclude rollback files.

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

Commands and output are recorded in `/tmp/ovd979-u3-proof/`: `bootstrap.sql`,
`migrations.log`, `psql`, `copy-inputs.py`, `roundtrip.sql` / `roundtrip.log`,
`pgtap-final.log`, `negative-control.log`, `prior-catalog.log`, `vitest.log`,
`fixture-vitest.log`, `app-typecheck.log`, `worker-typecheck.log`, and
`eslint.log`. The psql adapter executes only inside this run's local container;
pgTAP uses `pg_prove --norc -b /tmp/ovd979-u3-proof/psql -h /tmp -U postgres
-d postgres <test.sql>`. Container inputs are copied into tmpfs via stdin.
The owner record includes cleanup status and verified file hashes.

Exact-head independent review and hosted release qualification remain separate
integration work. U4 must add the attempt gate, and U5 must handle request
deduplication and deferred release; neither is claimed by U3.

## Status (OVD-979 U6)

The draft now carries a `SUPERSEDED` header so the function-collision check treats it as history: a later unit (U5) replaced one of its functions. The promoted migration file is unchanged; the draft equals it apart from that one header line.
