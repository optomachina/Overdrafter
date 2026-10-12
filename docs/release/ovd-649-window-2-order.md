# OVD-649 window 2 apply and rollback order

Source only. Nothing here is applied to a hosted database. The window 2 packet
(OVD-743) reads this file for the position of the OVD-649 staged observer SQL
relative to OVD-558 (#702, merged) and the OVD-619 reader and pending
finalization SQL (#619).

## Files

| Step | File | Role |
| --- | --- | --- |
| Forward | `scripts/native/stop-observer/sql/store-native-observer-evidence-replay.staged.sql` | `create or replace` of `engineering_private.store_native_observer_evidence(uuid,bytea,bytea)` |
| Reverse | `scripts/native/stop-observer/sql/store-native-observer-evidence-restore.staged.sql` | Paired restoration of the OVD-575 body |
| Generator | `scripts/native/stop-observer/sql/generate-restore-sql.mjs` | Writes the reverse; `--check` fails on drift |

The reverse is generated from the OVD-575 migration and the staged replacement;
never edit it by hand. It pins the replacement file SHA-256, the replacement body
MD5 (`f763f457581f994efb095a989bb7f270`) and the OVD-575 body MD5
(`7690e7cc953f97c9a422dcbaeb17cb8c`). In order it: refuses any isolation other
than READ COMMITTED with SQLSTATE 0A000; takes `pg_advisory_xact_lock(510, 2)`,
the lock the OVD-558 forward and reverse take, before touching any relation;
refuses unless exactly one function of that name exists, its body is exactly
the replacement, it is SECURITY DEFINER with `search_path=""`, owned by
`postgres`, and no role other than its owner and `ovd575_observer_validator` can
execute it; restores the OVD-575 definition byte for byte with `create or
replace`, which keeps the OID, owner and grants; and checks that the body is the
OVD-575 body and that security definer, configuration, owner, ACL, kind, return
type and language are unchanged. A second run refuses
(`ovd649_restore_unexpected_current_state`) without changing anything.

## Why the order matters

The OVD-558 forward preflight and reverse preflight each hash the whole catalog,
including `body_md5` and `definition_md5` of every function outside `pg_*`
schemas. The replacement changes the body of
`store_native_observer_evidence`, so:

- applied before the OVD-558 forward, it moves the digest the forward compares
  with its pinned prechange catalog, and the forward refuses;
- applied after the OVD-558 forward and left in place, it moves the digest the
  OVD-558 reverse compares with its pinned post change catalog, and the reverse
  refuses (`ovd558_unknown_postchange_catalog`), which blocks rollback.

Applying the replacement last and restoring it first keeps it outside both
moments the OVD-558 pins are read. The restoration returns the catalog byte for
byte, so the OVD-558 pins need no second accepted state and are not changed.

## Apply order (forward)

1. Active migrations through `20260927130000_ovd575_native_observer_registry`
   and `20260927140000_ovd576_atomic_native_stop` (prerequisites; already in the
   migration tree).
2. `docs/release/ovd-558-verifier-authority-forward.sql` (#702).
3. OVD-560, OVD-561 and OVD-563 staged forwards, in the order their contracts
   give.
4. #619 staged SQL: `ovd561-pending-forward.sql`, then
   `native-result-reader-forward.sql`, as #619 documents.
5. `store-native-observer-evidence-replay.staged.sql` (this PR). Last.

Steps 4 and 5 touch disjoint objects; #619 reads `native_observer_evidence` rows
and does not call or replace `store_native_observer_evidence`. Step 5 is still
last so that its reverse can run first.

## Rollback order (reverse)

Exactly the reverse of the steps that were applied, stopping at the step that
was reached:

1. `store-native-observer-evidence-restore.staged.sql` (this PR). First.
2. #619 reverses: `native-result-reader-reverse.sql`, then
   `ovd561-pending-reverse.sql`.
3. OVD-563, OVD-561, OVD-560 reverses.
4. `docs/release/ovd-558-verifier-authority-reverse.sql` (#702). Last.

Run each reverse as its own transaction at READ COMMITTED. Every OVD-558 and
OVD-649 script takes `pg_advisory_xact_lock(510, 2)` first, so two of them never
interleave. Retained `native_observer_evidence` rows stay valid after the
restoration; nothing is deleted.

## Proof

- `node scripts/test-ovd575-observer-registry.mjs --staged-replay`: the
  generated reverse matches its generator; REPEATABLE READ and SERIALIZABLE
  restorations are refused with 0A000; the restoration waits on a held (510,2)
  advisory lock; it returns the exact OVD-575 body, definition, OID, owner, ACL,
  security definer and configuration; the restored body no longer recovers a
  retained receipt; a second restoration is refused unchanged; reapply and
  restore again return the same states.
- `node scripts/ovd510-disposable-replay.mjs --reviewed-authority-baseline
  --durable-migration --ovd563` (the `Disposable staged SQL proof` CI job), stage
  `ovd649_window_order`, receipt `ovd649-window-order-proof.json`: after
  OVD-558/560/561/563 forward, a clone of the fixture database takes the
  current-main migration suffix (which creates the OVD-575 function), then the
  replacement. The OVD-558 reverse preflight, run verbatim with its pin moved to
  the clone's own pre-replacement digest, refuses while the replacement is live
  and accepts after the restoration; the restored catalog equals the
  pre-replacement catalog exactly; reapply and restore again repeat it. The
  clone and any role it created are dropped, and the source database catalog is
  checked unchanged before the OVD-563/561/560/558 reverses run.

#619's SQL is not on main, so the disposable chain does not include step 4 of
the forward order. The ordering argument does not depend on it: whatever #619
adds is applied before the replacement and reversed after the restoration.

## Note for the OVD-558 owner

No OVD-558 pin, preflight or generator input changes here. The OVD-558 pins were
computed on the reviewed migration prefix (`000d82a3`, 117 migrations), which
does not contain OVD-575 or later migrations. Whether a hosted pre-window catalog
matches those pins is a window 2 packet question for OVD-558, independent of this
PR; under the order above, the OVD-649 replacement never contributes to either
OVD-558 digest.
