# OVD-979 U4: attempt-bound auto approval

U4 is stacked on U2 and U3. It changes only
`public.api_auto_approve_job_requirements(uuid)`. It preserves U2's L1 job
lock and ordered L2/L3/L4 write phases, existing grants, quantities, vendors,
audit payload and failed-task count. It adds no schema, backfill, request RPC,
unique index, worker change or task settlement. The deferred backstop stays
one hour. The bodies and test scenarios were copied selectively from draft
#874, not cherry-picked; its timestamp exemption and finishing-task ID cache
are absent.

## Behavior

- A queued extraction task is pending. A running extraction task is finishing
  only when its non-null `attempt_id` equals the stored extraction's
  `source_attempt_id` for that same part. The rollup reads the current tuple
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

## Apply and rollback

`supabase/migrations/20261030165700_ovd979u4_attempt_bound_auto_approval.sql`
and `docs/migration-drafts/ovd-979u4.sql` are byte identical. Apply after U2/U3,
in one transaction. Both forward and rollback support repeated application
and have no transaction wrapper. No table, policy, owner or grant recipient
changes. The function keeps `SECURITY DEFINER`, pins
`search_path = pg_catalog, public`, revokes PUBLIC/anon/authenticated and
retains service_role-only execution.

`ovd-979u4.rollback.sql` restores the complete U2/U3-era definition and ACLs;
`md5(prosrc)` is **ba94c43be2ec78486ee9aca4679d2465**. The artifact test compares
the body bytes directly to U2's promoted migration. The local catalog proof
compares MD5, ACL and search path across repeat apply, repeat rollback and
reapply, and verifies claim/request definitions are untouched.

The complete forward body and byte-exact rollback exceed the normal line
budget. The behavioral change is one function; splitting it would not yield
independent changes. U2's draft is archived with one `SUPERSEDED` header so
replaying it cannot silently overwrite U4. U2's migration and body bytes stay
unchanged, and its test still compares every byte including the exact archival
header. No `function-supersessions.json` exception or checker/baseline change
is needed; the unchanged collision guard passes.

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
- Prior-body negative control fails the new ownership, attempt and status
  assertions; reapplying U4 restores the full pass. The saved negative-control
  log precedes removal of two unrequested failed-task-history assertions.

Evidence and runners: `/tmp/ovd979-u4-proof/` contains `owner.json`,
`bootstrap.sql`, `migrations.log`, `copy-inputs.py`, the container-only `psql`
adapter, `roundtrip.sql`/`roundtrip.log`, `pgtap-final.log`, `negative-control.log`,
`vitest.log`, `typecheck.log`, `eslint.log`, and checker logs. `pg_prove --norc
-b /tmp/ovd979-u4-proof/psql -h /tmp -U postgres -d postgres` runs the SQL inputs
copied into that container. Fixture cleanup is recorded in the owner artifact.

This proves SQL/catalog/RLS behavior and observed lock contention; it does not
prove GoTrue/PostgREST transport or hosted release qualification. Exact-head
independent migration review remains integration work. No commit, push, rebase,
PR, hosted apply, production or provider operation was performed.
