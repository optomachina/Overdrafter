# OVD-649 window 2 position

Source only. Nothing here is applied to a hosted database. The apply order and
reverse order of the whole window 2 Jarvis chain, including the OVD-649 observer
replacement and its restoration, live in one place: the run sheet,
[docs/release/window-2/README.md](window-2/README.md), pinned by
`docs/release/window-2/manifest.json`. This file explains only why OVD-649 sits
where it does.

## Files

| Role | File |
| --- | --- |
| Forward | `scripts/native/stop-observer/sql/store-native-observer-evidence-replay.staged.sql` (one transaction: READ COMMITTED check with 0A000, `pg_advisory_xact_lock(510, 2)`, then `create or replace` of `engineering_private.store_native_observer_evidence(uuid,bytea,bytea)`) |
| Reverse | `scripts/native/stop-observer/sql/store-native-observer-evidence-restore.staged.sql` (paired restoration of the OVD-575 body) |
| Generator | `scripts/native/stop-observer/sql/generate-restore-sql.mjs` (writes the reverse; `--check` fails on drift; `scripts/window2-packet.node-test.mjs` runs it in the portable lane) |

The reverse is generated from the OVD-575 migration and the staged replacement;
never edit it by hand. It pins the whole replacement file by SHA-256 and the
replacement body (`cee9b348b708fd02723b555ed894b727cc43f3c6e1951efee14607b711f0f9e1`) and
OVD-575 body (`6ec69c8214fe42427905f0501aa738cb0b2bee0d68d00d4d0c937c1e6d9f3bb4`). It refuses
any isolation other than READ COMMITTED with SQLSTATE 0A000, takes
`pg_advisory_xact_lock(510, 2)` before touching any relation, refuses unless the
live body is exactly the replacement with the expected owner, security definer,
configuration and grants, restores the OVD-575 definition byte for byte with
`create or replace` (keeping OID, owner and grants), and checks the result. A
second run refuses (`ovd649_restore_unexpected_current_state`) unchanged.

Every window 2 staged forward and reverse, OVD-558 included, now refuses anything
but READ COMMITTED and takes `pg_advisory_xact_lock(510, 2)` first;
`scripts/window2-packet.node-test.mjs` checks that for every file in the manifest.

## Why the replacement is last and its restoration first

The OVD-558 forward and reverse preflights each hash the whole catalog, including
`body_md5` and `definition_md5` of every function. The replacement changes the
body of `store_native_observer_evidence`, so:

- applied before the OVD-558 forward, it moves the digest the forward compares
  with its pinned prechange catalog, and the forward refuses;
- applied after the OVD-558 forward and left in place, it moves the digest the
  OVD-558 reverse compares with its pinned post change catalog, and the reverse
  refuses (`ovd558_unknown_postchange_catalog`).

Applying it last and restoring it first keeps it outside both moments the
OVD-558 pins are read. The restoration returns the catalog byte for byte.

## Proof

`node scripts/ovd510-disposable-replay.mjs --reviewed-authority-baseline
--durable-migration --ovd563` (the `Disposable staged SQL proof` CI job) runs
`scripts/ovd510-ovd649-window-order.mjs` inside the window 2 chain stage on the
reviewed 148 migration baseline (OVD-575 and OVD-576 included), with #702's real
pins and no substitute: with the replacement live the verbatim OVD-558 forward
refuses (`ovd558_prechange_catalog_mismatch`) and, right after the OVD-558
forward, the verbatim OVD-558 reverse refuses (`ovd558_unknown_postchange_catalog`);
after the restoration the catalog is exact, the reverse runs and the forward
reapplies to the same catalog. Each refusal is matched on its SQLSTATE.
`node scripts/test-ovd575-observer-registry.mjs --staged-replay` covers the
restoration's guards, lock wait, exact definition and reapply.
