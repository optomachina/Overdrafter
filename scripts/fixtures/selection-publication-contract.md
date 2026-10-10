# Selection and publication repair runtime proof

```sh
node scripts/ovd510-disposable-replay.mjs --selection-publication-contract
```

This exclusive mode uses the same immutable source export, hash-pinned 112-source
baseline and exact expiry migration as `--quote-selection-expiry`. It additionally
pins migration `20261002053133` and its 45-case fixture plus the updated 14-case
publication privilege fixture. No arbitrary SQL, database or combined mode is
admitted. It does not replay or qualify every migration in an integrated tree.

Before applying the publication repair, the mode runs the new 45-case fixture and
requires actual failures for the service-role UPDATE bypass, missing-source helper
and parent publication, and ambiguous-source inference. The raw TAP and effective
ACL/owner/definition snapshot are retained. This expected red phase must complete
all 45 assertions and roll back its records; an unrelated SQL abort is a failure.

A synthetic column UPDATE(note) grant then makes column revocation observable.
The repair is executed with an injected pre-commit error; exact before/after
helper definition and table/column ACL snapshots must match. The unchanged
transactional migration is then applied normally. All 45 repair cases and 14
publication authorization cases must pass; effective table/column privileges and
owner-only helper access are inspected separately. Both fixture transactions must
leave no synthetic organizations. The unchanged 32 expiry assertions, 11 controls
and six observed-lock races then run against the repaired schema.

`selection-publication-proof.json` retains both red/green TAP, input hashes,
rollback and ACL verdicts. `quote-expiry-proof.json` retains the existing expiry
and concurrency verdicts. The parent result, source manifest, submitted-input
inventory and exact owned-resource cleanup determine overall success. This proves
synthetic database behavior only, not UI/browser behavior, production data/schema
compatibility, actual image qualification, integration gates or deployment.
