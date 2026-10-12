# Selection write and publication source contract repair

Base: integrated candidate `0263731698a130f2c2d404dc79d2131dc3c8e10f`.
This is source-only follow-up migration `20261002053133`. The expiry migration
`20261002041305`, its pinned 32-case fixture, and all runner files remain unchanged.
No production application, provider action, publication, or merge is authorized.

## Direct selection UPDATE

The prior migration revoked INSERT only. The baseline service role still held
UPDATE and bypasses RLS, so it could replace an existing selection's option or
identity without the guarded RPC. The new migration revokes UPDATE at both table
and all existing column levels from PUBLIC, anon, authenticated and service_role.
There is no required direct selection-update consumer in the inspected source.
SELECT/history, guarded INSERT through the RPC, RLS, job pointer clearing and
unrelated job edits are unchanged. No selection or audit row is rewritten.

## Publication and historical options

The maintained public publication RPC still uses its existing owner-only helper.
That helper now requires a real exact source offer, binding package, quote run,
job, organization, result and requested quantity. Its commercial total, unit price
and lead-time fields must match the result fields used for publication. The
existing deterministic markup calculation is unchanged.

An explicit offer ID must satisfy those bindings. With no explicit ID there must
be exactly one variant for the result; even one apparently matching-price variant
among several is not enough. Missing or ambiguous sources produce `Publication
requires one exact matching source offer.` No sort-rank or cheapest-offer guess
remains. The helper rejects invalidation and known expiry before writing, retaining
linked legacy null validity and the existing inclusive deadline predicate.
It locks the source offer, not the job: the parent processes every option before
its final job update. This avoids retaining a job lock while requesting a later
offer lock. Selection RPC job-lock/deadline enforcement remains unchanged.

The actual publish RPC propagates the helper error, rolling back its package
upsert, option deletion, job/run changes and audit writes. A successful result
without any offer rows is therefore not publishable. Existing multi-variant
results without an explicit source mapping now require operator/contract review;
this is deliberately fail-closed and is not a new provider policy or automatic
source-selection mechanism.

Historical options whose source link is absent are retired from new selection:
they and their prices/history stay visible, the UI displays refresh guidance,
and both its disabled action and mutation guard prevent a request. The server's
missing-source rejection remains intact. This migration performs no automatic
backfill, relinking, deletion, or data rewrite. Unknown deadline on an actually
linked legacy offer remains different from missing linkage.

## Evidence and runtime handoff

Two source contract assertions failed before the migration was implemented and
then passed. The UI owner reproduced enabled-source-less/mutation-bypass failures
before its fix; component tests cover retirement, linked legacy success and the
mutation guard. The final focused run passed 11 tests (new source contract,
retained expiry source checks and four UI cases). Root typechecks, scoped lint,
migration lineage and whitespace checks passed. Independent source review cleared
the migration, UI and 45-assertion SQL fixture after the lock-order correction.
These are source/component evidence, not real PostgreSQL proof.

`supabase/tests/quote_selection_publication_contract.sql` adds runtime cases for
effective table/column privileges, actual service-role UPDATE denial, unchanged
state, helper source rejection and the maintained publication path. The existing
publication-privilege fixture's success seed now includes a legitimate source
offer; its positive authorization assertion is not relaxed.

Task11 must admit the new migration and fixture into the maintained immutable
runner and record before/after SQL evidence, ACL/owner inspection, unchanged-state
checks, rollback and owned cleanup. Retain the original expiry fixture, 11 extra
controls, and all six observed-lock races. Old runner evidence does not qualify
these new inputs. No runner files were edited by this source owner. Real browser
coverage, independent required security review and final integrated verification
remain separate gates.

## Rollback

The migration is transactional and contains no data backfill. Failure before
commit rolls back schema/ACL changes. After deployment prefer a forward fix.
Intentional rollback restores the previous helper body from `20260307190000`
while retaining its owner-only ACL, and restores only captured pre-deployment
UPDATE grants if explicitly accepting the reopened bypass. Do not assume default
ACLs or remove expiry checks to recover publication. No rollback was executed.
