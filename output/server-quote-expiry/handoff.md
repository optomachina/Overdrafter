# Server expiry source handoff

Owner: task-4, /root; Mac local workspace task-4/Overdrafter.
Branch: fix/server-quote-expiry; base 6fcbf41d5a3380a97b8b7eab5d97793cfc28f2ff.
Scope: server RPC expiry and direct API bypass closure. No pricing/publication changes.
Allowed actions used: isolated source edits, synthetic source tests, local checks, review, commit.
No database migration application, customer/provider operations, credentials, or deployment.
Completion: local reviewable commit with SQL-runtime/deployment gates explicit.

Files: new migration 20261002041305, 32-assertion pgTAP fixture, five source contract tests,
new server acceptance/rollback notes, correction to prior client-only acceptance claims.
Bounded source review by independent_review cleared RPC guards and both direct-write fixes.

Evidence: fail-before.log records four prior-definition source assertion failures, not
executed PostgreSQL behavior. Focused client/source tests: 66 passed. The first aggregate
run reached unit tests after lineage/provider/agent-control/lint/types passed but sandbox
loopback binding returned EPERM. Full unit suite rerun received loopback permission.
Build and worker verification passed independently after initial aggregate stopped.

Pending: maintained immutable PostgreSQL runner executes pgTAP and captures ACL/RLS,
role-owner/trigger and rollback results. Concurrency: job-lock wait past expiry, and
selection versus administrative invalidation. Required independent security review on
integrated revision and deployment approval remain separate gates.

Task-to-task status transmission was rejected by automatic approval review for missing
trusted destination-specific messaging authorization; no alternate route or retry used.
Use this artifact/final result as handoff. Original Jev four-feature commit ab59e8b8
remains on branch ancestry, as do transport fe95a263 and client guard 6fcbf41d.

Final unit rerun: 408 files passed; 5924 tests passed, 1 skipped. Fixture source
review also cleared with no blockers. Runtime database evidence remains pending.

Final source commit: d68aafbf54b13f7f51cbaa7b45437cf33f9cdc8c.
