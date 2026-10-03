# Server quote selection expiry follow-up

The client expiry guard did not protect a selection made after an idle tab's
cached offer expired. Neither selection RPC previously checked `valid_until`.
Migration `20261002041305_enforce_quote_selection_expiry.sql` adds a server
wall-clock check to both selection paths, after locking the offer and job.
A deadline equal to the check instant is valid. A linked legacy offer with no
deadline remains selectable; missing source offers are not treated as legacy.

The published path requires the exact source offer, result, quote run, job, and
organization to agree, and rejects invalidated offers. The existing legacy
verified-auth/access and first-part rules are preserved. No price, publication,
or provider workflow changes are included.

Direct API writes cannot bypass the RPC: INSERT on `client_selections` is revoked
from PUBLIC and supported API roles, and its obsolete insert policy is removed.
A security-invoker trigger rejects non-null direct job-offer assignments by anon,
authenticated, and service_role writers. It allows clearing and unrelated job
edits. Privileged database owners remain administrators; SECURITY DEFINER RPCs
retain their owner execution context. The trigger must not be changed to SECURITY
DEFINER, which would hide the calling write role.

## Source evidence

Four source assertions failed against the prior RPC definitions before the
migration body was implemented. Five now pass, including direct-write guard
coverage; the connected client suite passes 61 tests (66 combined). These are
source contract checks, not executed PostgreSQL proof. Root typechecks, scoped
lint, and migration lineage passed. Bounded independent source review found no
remaining blockers after both direct-write bypasses were closed. `supabase/tests/quote_selection_expiry.sql` provides 32 synthetic pgTAP assertions in a rollback
fixture for the maintained isolated database runner.

Aggregate evidence: the first `npm run verify` passed lineage, provider checks,
agent-control tests, lint, and types, then hit sandbox `listen EPERM` in local HTTP
fixtures. The permitted full unit-suite rerun passed **408 files / 5,924 tests**
with one skipped. Build and worker verification also passed separately. The
initial aggregate failure is retained rather than represented as a single green
`npm run verify` invocation. The 32-assertion SQL fixture is still unexecuted.

## Required integration and deployment gates

This is source only. No local or hosted database migration has been applied by
this task. Before integration, run the new pgTAP fixture through the maintained
immutable synthetic runner and record catalog, ACL/RLS, authenticated RPC, and
rollback verdicts. Exercise a concurrent selection waiting for the job lock until
a deadline passes, plus selection versus administrative invalidation. The test
must prove the later wall clock is used and that failure leaves no selection,
status, or audit write. Run the aggregate repository gate and required independent
security review on the integrated revision. A successful source check is not a
substitute for these gates. Production deployment requires separate approval.

## Migration and rollback impact

The migration adds two private functions and one jobs trigger, replaces two RPC
bodies without changing signatures, and removes direct selection insert access.
The transaction makes application atomic. It does not rewrite historical offers
or selections. Existing historical selections can remain visible after expiry;
this change guards new selection actions rather than deleting history.

If a controlled rollout fails before commit, roll back the transaction. After
commit, prefer a forward fix. A deliberate rollback must restore the previous RPC
bodies from migrations `20260812045000` and `20260304010000`, drop the new trigger
and private functions after restoring callers, and restore the previous selection
insert grants/policy only after accepting that this reopens the bypass. Capture
actual pre-deployment ACLs rather than assuming grant defaults. No rollback SQL
has been run or production deployment authorized here.
