# Finding: `--ovd563` disposable proof fails on origin/main 8d8d243 with `ovd563_reverse_catalog_drift`

Command: `node scripts/ovd510-disposable-replay.mjs --reviewed-authority-baseline --durable-migration --ovd563`
(requires `git fetch origin 000d82a323d887414eb86f1dfe7d105c0b5a776c` and Docker Hub images re-tagged as public.ecr.aws names).

Observed (2 runs, 2026-10-04 ~08:35 and ~08:50 UTC):
- OVD-560 behavior 11/11 ok, OVD-561 behavior 24/24 ok, races ok, OVD-563 behavior 21/21 ok, OVD-563 rollback catalog unchanged.
- Fails at `psql(reverse563)` comparison against `catalog561` (scripts/ovd510-disposable-replay.mjs:741-743).

Root cause (instrumented scratch copy, catalogs diffed): after reverse563 the cluster has two extra roles that are absent from
`catalog561`: `ovd575_observer_validator` and `ovd576_stop_validator` (+ their caller entries on every function).
They are created by migrations 20260927130000_ovd575_native_observer_registry.sql:8-9 and 20260927140000_ovd576_atomic_native_stop.sql:8-9,
which `runFinalizationRaceProof` (scripts/ovd561-race-proof.mjs:58-59) applies as the "current-main suffix" in a clone session.
Roles are cluster-global, so applying the suffix leaks them into the shared cluster catalog AFTER `catalog561` was captured.
The OVD-563 forward/reverse SQL is not the cause.

Fix options: (a) race proof records pre-existing roles and drops roles it created during cleanup (owned-resource cleanup), and
the runner asserts the cluster role set is restored; or (b) runner captures the comparison baseline immediately before forward563.
(a) is preferred: it removes the leak instead of moving the baseline.
Evidence: scratchpad/evidence-ovd563-reverse-drift/ (result.json, behaviors) and output/ovd510-replay-e220ea6e (diag catalogs).
